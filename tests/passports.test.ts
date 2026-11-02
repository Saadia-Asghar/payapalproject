// Payment seam, Purchase Passport and dispute packets.
// PayPal itself is not called here: the values passed to attachPayPalOrder/recordCapture are
// test doubles standing in for the Phase 3 adapter's verified PayPal responses.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivatePem, keyFromPrivatePem } from "../src/server/crypto/signing.ts";
import { createTestDb, type Db } from "../src/server/db/client.ts";
import { approveCart, evaluateAndRecord } from "../src/server/services/carts.ts";
import { getDispute, listMerchantActivity, openSampleDispute, reviewDispute } from "../src/server/services/disputes.ts";
import { getPassportForOwner, publicVerify, verifyUploaded } from "../src/server/services/passports.ts";
import { attachPayPalOrder, closeCheckout, recordCapture, reserveCheckout } from "../src/server/services/payments.ts";
import { approvePermission, assertVersionUsable, createPermission, reviewPermission, revokePermission, ServiceError } from "../src/server/services/permissions.ts";
import { NOW, validForm } from "./fixtures.ts";

const signingKey = keyFromPrivatePem(generatePrivatePem());
const CONSENTS = { checked_terms: true, ai_may_err: true, no_charge_yet: true };
const FAKE_PAYPAL_ORDER = "5O190127TN364715T";
const FAKE_CAPTURE = "3C679366HH908993F";

let db: Db;
let buyer: string;
let merchant: string;

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ServiceError && e.code === code);
}

async function approvedCart(sku = "CW-SNK-RUN-WHT-M10") {
  const { id: pid } = await createPermission(db, buyer, validForm());
  const r = await reviewPermission(db, buyer, pid, NOW);
  await approvePermission(db, { userId: buyer, sessionId: "s", permissionId: pid, termsHash: r.termsHash, consents: CONSENTS, now: NOW, signingKey });
  const cart = await evaluateAndRecord(db, { userId: buyer, permissionId: pid, sku, now: NOW, signingKey });
  if (cart.verdict === "ALLOW") await approveCart(db, { userId: buyer, attemptId: cart.id, cartHash: cart.cartHash, now: NOW });
  return { pid, cart };
}

async function paidPassport() {
  const { pid, cart } = await approvedCart();
  const res = await reserveCheckout(db, { userId: buyer, attemptId: cart.id, now: NOW });
  await attachPayPalOrder(db, { paymentOrderId: res.paymentOrderId, paypalOrderId: FAKE_PAYPAL_ORDER, now: NOW });
  const cap = await recordCapture(db, {
    paymentOrderId: res.paymentOrderId,
    paypalOrderId: FAKE_PAYPAL_ORDER,
    captureId: FAKE_CAPTURE,
    captureStatus: "COMPLETED",
    amount: "120.00",
    currency: "USD",
    rawResponse: { id: FAKE_PAYPAL_ORDER, status: "COMPLETED" },
    now: NOW,
    signingKey,
  });
  return { pid, cart, res, passportId: cap.passportId };
}

beforeEach(async () => {
  db = await createTestDb();
  [{ id: buyer }] = await db.query<{ id: string }>("INSERT INTO users (email, display_name, role) VALUES ('b@x.test', 'B', 'BUYER') RETURNING id");
  [{ id: merchant }] = await db.query<{ id: string }>("INSERT INTO users (email, display_name, role) VALUES ('m@x.test', 'M', 'MERCHANT') RETURNING id");
  await db.query("UPDATE merchants SET owner_user_id = $1 WHERE id = 'DEMO-SNEAKER-STORE'", [merchant]);
});
afterEach(async () => db.close());

describe("checkout reservation (policy gate before PayPal)", () => {
  it("returns PayPal order inputs from the trusted cart, idempotently", async () => {
    const { cart } = await approvedCart();
    const a = await reserveCheckout(db, { userId: buyer, attemptId: cart.id, now: NOW });
    const b = await reserveCheckout(db, { userId: buyer, attemptId: cart.id, now: NOW });
    expect(a).toMatchObject({
      amount: "120.00",
      currency: "USD",
      merchantId: "DEMO-SNEAKER-STORE",
      breakdown: { itemTotal: "105.00", shipping: "8.70", tax: "6.30" },
    });
    expect(a.reconciliationKey).toMatch(/^CW-CASE-\d{5}$/);
    expect(b.paymentOrderId).toBe(a.paymentOrderId);
    expect(b.paypalRequestId).toBe(a.paypalRequestId);
  });

  it("refuses blocked carts, unapproved carts, changed prices and revoked permissions", async () => {
    const blocked = await approvedCart("CW-SNK-RUN-WHT-M9");
    await expectCode(reserveCheckout(db, { userId: buyer, attemptId: blocked.cart.id, now: NOW }), "NOT_ALLOWED");

    const { pid } = await approvedCart();
    const unapproved = await evaluateAndRecord(db, { userId: buyer, permissionId: pid, sku: "CW-SNK-RUN-KES-M10", now: NOW, signingKey });
    await expectCode(reserveCheckout(db, { userId: buyer, attemptId: unapproved.id, now: NOW }), "CART_NOT_APPROVED");

    const priced = await approvedCart();
    await db.query("UPDATE catalog_products SET shipping = 9.99 WHERE sku = 'CW-SNK-RUN-WHT-M10'");
    await expectCode(reserveCheckout(db, { userId: buyer, attemptId: priced.cart.id, now: NOW }), "CART_CHANGED");
    await db.query("UPDATE catalog_products SET shipping = 8.70 WHERE sku = 'CW-SNK-RUN-WHT-M10'");

    const revoked = await approvedCart();
    await revokePermission(db, buyer, revoked.pid, NOW);
    await expectCode(reserveCheckout(db, { userId: buyer, attemptId: revoked.cart.id, now: NOW }), "REVOKED");
  });

  it("is private to the buyer", async () => {
    const { cart } = await approvedCart();
    await expectCode(reserveCheckout(db, { userId: merchant, attemptId: cart.id, now: NOW }), "NOT_FOUND");
  });
});

describe("capture recording", () => {
  it("rejects incomplete captures, wrong amounts and wrong orders", async () => {
    const { cart } = await approvedCart();
    const res = await reserveCheckout(db, { userId: buyer, attemptId: cart.id, now: NOW });
    const base = {
      paymentOrderId: res.paymentOrderId,
      paypalOrderId: FAKE_PAYPAL_ORDER,
      captureId: FAKE_CAPTURE,
      captureStatus: "COMPLETED",
      amount: "120.00",
      currency: "USD",
      rawResponse: {},
      now: NOW,
      signingKey,
    };
    await expectCode(recordCapture(db, base), "NOT_CAPTURABLE"); // no PayPal order attached yet
    await attachPayPalOrder(db, { paymentOrderId: res.paymentOrderId, paypalOrderId: FAKE_PAYPAL_ORDER, now: NOW });
    await expectCode(attachPayPalOrder(db, { paymentOrderId: res.paymentOrderId, paypalOrderId: "9XX99999XX9999999", now: NOW }), "ORDER_MISMATCH");
    await expectCode(recordCapture(db, { ...base, captureStatus: "PENDING" }), "CAPTURE_NOT_COMPLETED");
    await expectCode(recordCapture(db, { ...base, amount: "1.00" }), "AMOUNT_MISMATCH");
    await expectCode(recordCapture(db, { ...base, currency: "EUR" }), "AMOUNT_MISMATCH");
    await expectCode(recordCapture(db, { ...base, paypalOrderId: "9XX99999XX9999999" }), "ORDER_MISMATCH");
  });

  it("consumes the single-use permission and issues one passport; repeats are idempotent", async () => {
    const { pid, cart, res, passportId } = await paidPassport();
    expect(passportId).toMatch(/^CW-PP-\d{5}$/);
    const again = await recordCapture(db, {
      paymentOrderId: res.paymentOrderId,
      paypalOrderId: FAKE_PAYPAL_ORDER,
      captureId: FAKE_CAPTURE,
      captureStatus: "COMPLETED",
      amount: "120.00",
      currency: "USD",
      rawResponse: {},
      now: NOW,
      signingKey,
    });
    expect(again).toEqual({ passportId, duplicate: true });
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM payment_captures");
    expect(n).toBe(1);

    const [v] = await db.query<{ id: string }>("SELECT v.id FROM permission_versions v WHERE v.permission_id = $1", [pid]);
    await expectCode(assertVersionUsable(db, v.id, NOW), "CONSUMED");
    await expectCode(reserveCheckout(db, { userId: buyer, attemptId: cart.id, now: NOW }), "CONSUMED");
  });

  it("cancels an older unpaid reservation when the buyer checks out a different cart", async () => {
    const { pid, cart } = await approvedCart();
    const first = await reserveCheckout(db, { userId: buyer, attemptId: cart.id, now: NOW });
    const second = await evaluateAndRecord(db, { userId: buyer, permissionId: pid, sku: "CW-SNK-RUN-KES-M10", now: NOW, signingKey });
    await approveCart(db, { userId: buyer, attemptId: second.id, cartHash: second.cartHash, now: NOW });
    await reserveCheckout(db, { userId: buyer, attemptId: second.id, now: NOW });
    const [o] = await db.query<{ status: string }>("SELECT status FROM payment_orders WHERE id = $1", [first.paymentOrderId]);
    expect(o.status).toBe("CANCELLED");
    await expect(closeCheckout(db, { paymentOrderId: first.paymentOrderId, status: "FAILED", reason: "x", now: NOW })).resolves.toEqual({ status: "CANCELLED" });
  });
});

describe("Purchase Passport", () => {
  it("verifies end to end for its owner", async () => {
    const { passportId } = await paidPassport();
    const p = await getPassportForOwner(db, buyer, passportId);
    expect(p.valid).toBe(true);
    expect(p.checks.every((c) => c.ok)).toBe(true);
    expect(p.bundle.payment).toMatchObject({ paypal_capture_id: FAKE_CAPTURE, amount: "120.00", environment: "PAYPAL_SANDBOX" });
    await expectCode(getPassportForOwner(db, merchant, passportId), "NOT_FOUND");
  });

  it("detects any edit to a downloaded bundle", async () => {
    const { passportId } = await paidPassport();
    const { signed } = await getPassportForOwner(db, buyer, passportId);
    expect((await verifyUploaded(db, signed)).valid).toBe(true);

    const edited = structuredClone(signed);
    edited.bundle.payment.amount = "12.00";
    const r = await verifyUploaded(db, edited);
    expect(r.valid).toBe(false);
    expect(r.checks.find((c) => c.label.startsWith("Passport signature"))?.ok).toBe(false);

    const swapped = structuredClone(signed);
    swapped.bundle.permission.terms_hash = "sha256:" + "1".repeat(64);
    expect((await verifyUploaded(db, swapped)).valid).toBe(false);

    expect((await verifyUploaded(db, { nonsense: true })).valid).toBe(false);
  });

  it("public verification is redacted and flags database tampering", async () => {
    const { passportId } = await paidPassport();
    const pub = await publicVerify(db, passportId);
    expect(pub).toMatchObject({ found: true, valid: true, verification: "SERVER_VERIFIED" });
    const text = JSON.stringify(pub);
    expect(text).not.toContain(buyer);
    expect(text).not.toContain("CW-SNK-RUN-WHT-M10");
    expect(text).not.toContain("SAVED_ADDRESS");

    await db.exec("ALTER TABLE payment_captures DISABLE TRIGGER payment_captures_immutable");
    await db.query("UPDATE payment_captures SET amount = 1.00");
    expect((await publicVerify(db, passportId)).valid).toBe(false);
    expect(await publicVerify(db, "CW-PP-99999")).toEqual({ found: false, passport_id: "CW-PP-99999" });
  });

  it("cannot be edited in the database", async () => {
    await paidPassport();
    await expect(db.query("UPDATE passports SET signature = 'x'")).rejects.toThrow(/CW_IMMUTABLE/);
  });
});

describe("merchant workspace and sample disputes", () => {
  it("shows the merchant only carts for their own store", async () => {
    await approvedCart();
    await approvedCart("CW-OUT-RUN-WHT-M10"); // outlet market, not this merchant's store
    const rows = await listMerchantActivity(db, merchant);
    expect(rows.length).toBe(1);
    expect(rows[0].merchant_id).toBe("DEMO-SNEAKER-STORE");
    expect(await listMerchantActivity(db, buyer)).toEqual([]);
  });

  it("builds a labelled, grounded packet that lists missing delivery evidence", async () => {
    const { cart, passportId } = await paidPassport();
    const { id } = await openSampleDispute(db, { userId: merchant, attemptId: cart.id, reason: "NOT_RECEIVED", complaint: "Never arrived", now: NOW });
    const { packet, packetIntact, dispute } = await getDispute(db, merchant, id);
    expect(packetIntact).toBe(true);
    expect(dispute.source).toBe("SAMPLE");
    expect(packet.notice).toMatch(/^SAMPLE CASE/);
    expect(packet.subject).toMatchObject({ passport_id: passportId, paypal_capture_id: FAKE_CAPTURE });
    expect(packet.checklist.filter((c) => c.status === "MISSING").map((c) => c.label)).toEqual(
      expect.arrayContaining(["Shipment tracking number", "Carrier proof of delivery"]),
    );
    expect(JSON.stringify(packet)).not.toContain(buyer);
  });

  it("reports an unpaid cart honestly and confirms authorization evidence", async () => {
    const { cart } = await approvedCart();
    const { id } = await openSampleDispute(db, { userId: merchant, attemptId: cart.id, reason: "NOT_AUTHORIZED", complaint: "", now: NOW });
    const { packet } = await getDispute(db, merchant, id);
    const byLabel = Object.fromEntries(packet.checklist.map((c) => [c.label, c.status]));
    expect(byLabel["Buyer approval event"]).toBe("PROVIDED");
    expect(byLabel["Buyer approval of this exact cart"]).toBe("PROVIDED");
    expect(byLabel["PayPal order and capture identifiers"]).toBe("MISSING");
  });

  it("confirms a mismatch for 'agent exceeded instructions' on a blocked cart", async () => {
    const { cart } = await approvedCart("CW-SNK-RUN-WHT-M10-PRO");
    const { id } = await openSampleDispute(db, { userId: merchant, attemptId: cart.id, reason: "EXCEEDED_INSTRUCTIONS", complaint: "", now: NOW });
    const { packet } = await getDispute(db, merchant, id);
    expect(packet.findings.join(" ")).toMatch(/Mismatch confirmed/);
  });

  it("other merchants cannot open or read cases; review happens once", async () => {
    const { cart } = await approvedCart();
    const [{ id: other }] = await db.query<{ id: string }>("INSERT INTO users (email, display_name, role) VALUES ('o@x.test', 'O', 'MERCHANT') RETURNING id");
    await expectCode(openSampleDispute(db, { userId: other, attemptId: cart.id, reason: "WRONG_ITEM", complaint: "", now: NOW }), "NOT_FOUND");
    const { id } = await openSampleDispute(db, { userId: merchant, attemptId: cart.id, reason: "WRONG_ITEM", complaint: "", now: NOW });
    await expectCode(getDispute(db, other, id), "NOT_FOUND");
    await reviewDispute(db, { userId: merchant, caseId: id, note: "Requested fulfilment record from warehouse.", now: NOW });
    await expectCode(reviewDispute(db, { userId: merchant, caseId: id, note: "again", now: NOW }), "ALREADY_REVIEWED");
    expect((await getDispute(db, merchant, id)).dispute.status).toBe("REVIEWED");
  });
});
