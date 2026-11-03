// Phase 3 checkout against a fake PayPal REST server (no network, no real keys).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvalOptions, registrationOptions, verifyRegistration } from "../src/server/auth/webauthn.ts";
import { generatePrivatePem, keyFromPrivatePem } from "../src/server/crypto/signing.ts";
import { createTestDb, type Db } from "../src/server/db/client.ts";
import { createPayPalClient } from "../src/server/paypal/client.ts";
import { approveCart, evaluateAndRecord } from "../src/server/services/carts.ts";
import { cancelCheckout, captureCheckout, handleWebhook, startCheckout } from "../src/server/services/checkout.ts";
import { getPassportForOwner, verifyUploaded } from "../src/server/services/passports.ts";
import { approvePermission, createPermission, reviewPermission, revokePermission, ServiceError } from "../src/server/services/permissions.ts";
import { validForm } from "./fixtures.ts";
import { SoftAuthenticator } from "./soft-authenticator.ts";

// Checkout runs "now", so the permission deadline must be in the future.
const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
const signingKey = keyFromPrivatePem(generatePrivatePem());

interface FakeState {
  orders: Map<string, { amount: string; currency: string; requestId: string; captured?: string }>;
  calls: { method: string; path: string; requestId?: string }[];
  captureStatus: string;
  captureAmountOverride?: string;
  declineCapture?: boolean;
  webhookValid: boolean;
}

function fakePayPal(state: FakeState) {
  let n = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = new Headers(init.headers);
    state.calls.push({ method: init.method ?? "GET", path, requestId: headers.get("PayPal-Request-Id") ?? undefined });
    if (path === "/v1/oauth2/token") return json(200, { access_token: "test-token", expires_in: 3600 });
    if (headers.get("Authorization") !== "Bearer test-token") return json(401, { message: "unauthorized" });
    if (path === "/v2/checkout/orders" && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      const requestId = headers.get("PayPal-Request-Id")!;
      const existing = [...state.orders].find(([, o]) => o.requestId === requestId);
      if (existing) return json(200, { id: existing[0], status: "CREATED" }); // PayPal idempotency
      const id = `TESTORDER${String(++n).padStart(8, "0")}`;
      state.orders.set(id, { amount: body.purchase_units[0].amount.value, currency: body.purchase_units[0].amount.currency_code, requestId });
      return json(201, { id, status: "CREATED" });
    }
    const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(path);
    const get = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(path);
    const id = capture?.[1] ?? get?.[1];
    if (id) {
      const o = state.orders.get(id);
      if (!o) return json(404, { message: "not found" });
      const body = (capId: string) => ({
        id,
        status: "COMPLETED",
        purchase_units: [
          { payments: { captures: [{ id: capId, status: state.captureStatus, amount: { value: state.captureAmountOverride ?? o.amount, currency_code: o.currency } }] } },
        ],
      });
      if (capture) {
        if (state.declineCapture) return json(422, { details: [{ issue: "INSTRUMENT_DECLINED", description: "declined" }] });
        if (o.captured) return json(422, { details: [{ issue: "ORDER_ALREADY_CAPTURED", description: "already" }] });
        o.captured = `TESTCAP${id.slice(-8)}`;
        return json(201, body(o.captured));
      }
      return json(200, o.captured ? body(o.captured) : { id, status: "APPROVED" });
    }
    if (path === "/v1/notifications/verify-webhook-signature") return json(200, { verification_status: state.webhookValid ? "SUCCESS" : "FAILURE" });
    return json(404, {});
  }) as unknown as typeof fetch;
  return createPayPalClient({ clientId: "id", clientSecret: "secret", apiBase: "https://paypal.test", webhookId: "WH-1", fetch: fakeFetch });
}

let db: Db;
let buyer: string;
let state: FakeState;

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ServiceError && e.code === code);
}

async function approvedCart() {
  const { id: pid } = await createPermission(db, buyer, { ...validForm(), expires_at: future });
  const r = await reviewPermission(db, buyer, pid);
  await approvePermission(db, {
    userId: buyer,
    sessionId: "s",
    permissionId: pid,
    termsHash: r.termsHash,
    consents: { checked_terms: true, ai_may_err: true, no_charge_yet: true },
    signingKey,
  });
  const cart = await evaluateAndRecord(db, { userId: buyer, permissionId: pid, sku: "CW-SNK-RUN-WHT-M10", signingKey });
  await approveCart(db, { userId: buyer, attemptId: cart.id, cartHash: cart.cartHash });
  return { pid, attemptId: cart.id };
}

beforeEach(async () => {
  db = await createTestDb();
  [{ id: buyer }] = await db.query<{ id: string }>("INSERT INTO users (email, display_name, role) VALUES ('b@x.test', 'B', 'BUYER') RETURNING id");
  state = { orders: new Map(), calls: [], captureStatus: "COMPLETED", webhookValid: true };
});
afterEach(async () => db.close());

describe("PayPal checkout", () => {
  it("is clearly unavailable until keys are configured", async () => {
    const { attemptId } = await approvedCart();
    await expectCode(startCheckout(db, null, { userId: buyer, attemptId }), "PAYPAL_NOT_CONFIGURED");
  });

  it("creates one order for the trusted amount, captures it and issues a verifiable passport", async () => {
    const pp = fakePayPal(state);
    const { attemptId } = await approvedCart();
    const a = await startCheckout(db, pp, { userId: buyer, attemptId });
    const again = await startCheckout(db, pp, { userId: buyer, attemptId }); // double click
    expect(again).toEqual(a);
    expect(state.orders.size).toBe(1);
    expect(state.orders.get(a.paypalOrderId)).toMatchObject({ amount: "120.00", currency: "USD" });

    const res = await captureCheckout(db, pp, { userId: buyer, paymentOrderId: a.paymentOrderId });
    expect(res.status).toBe("CAPTURED");
    const passport = await getPassportForOwner(db, buyer, res.passportId!);
    expect(passport.valid).toBe(true);
    expect(passport.bundle.payment.paypal_order_id).toBe(a.paypalOrderId);

    // Retrying capture returns the same passport and makes no second capture call.
    const capturesBefore = state.calls.filter((c) => c.path.endsWith("/capture")).length;
    expect(await captureCheckout(db, pp, { userId: buyer, paymentOrderId: a.paymentOrderId })).toEqual(res);
    expect(state.calls.filter((c) => c.path.endsWith("/capture")).length).toBe(capturesBefore);
    await expectCode(startCheckout(db, pp, { userId: buyer, attemptId }), "CONSUMED");
  });

  it("reconciles when PayPal says the order was already captured", async () => {
    const pp = fakePayPal(state);
    const { attemptId } = await approvedCart();
    const a = await startCheckout(db, pp, { userId: buyer, attemptId });
    state.orders.get(a.paypalOrderId)!.captured = "TESTCAPLOST0001"; // captured, but our response was lost
    const res = await captureCheckout(db, pp, { userId: buyer, paymentOrderId: a.paymentOrderId });
    expect(res.status).toBe("CAPTURED");
  });

  it("refuses capture if the permission was revoked after PayPal approval", async () => {
    const pp = fakePayPal(state);
    const { pid, attemptId } = await approvedCart();
    const a = await startCheckout(db, pp, { userId: buyer, attemptId });
    await revokePermission(db, buyer, pid);
    await expectCode(captureCheckout(db, pp, { userId: buyer, paymentOrderId: a.paymentOrderId }), "REVOKED");
    expect(state.calls.some((c) => c.path.endsWith("/capture"))).toBe(false);
  });

  it("refuses to record a capture whose amount differs from the reserved amount", async () => {
    state.captureAmountOverride = "1.00";
    const pp = fakePayPal(state);
    const { attemptId } = await approvedCart();
    const a = await startCheckout(db, pp, { userId: buyer, attemptId });
    await expectCode(captureCheckout(db, pp, { userId: buyer, paymentOrderId: a.paymentOrderId }), "AMOUNT_MISMATCH");
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM passports");
    expect(n).toBe(0);
  });

  it("handles declines, pending captures and cancellation", async () => {
    state.declineCapture = true;
    const pp = fakePayPal(state);
    const { attemptId } = await approvedCart();
    const a = await startCheckout(db, pp, { userId: buyer, attemptId });
    await expectCode(captureCheckout(db, pp, { userId: buyer, paymentOrderId: a.paymentOrderId }), "PAYMENT_DECLINED");

    state.declineCapture = false;
    state.captureStatus = "PENDING";
    expect((await captureCheckout(db, pp, { userId: buyer, paymentOrderId: a.paymentOrderId })).status).toBe("PENDING");

    const { attemptId: second } = await approvedCart();
    const b = await startCheckout(db, pp, { userId: buyer, attemptId: second });
    expect(await cancelCheckout(db, { userId: buyer, paymentOrderId: b.paymentOrderId })).toEqual({ status: "CANCELLED" });
  });

  it("does not let another user capture or cancel", async () => {
    const pp = fakePayPal(state);
    const { attemptId } = await approvedCart();
    const a = await startCheckout(db, pp, { userId: buyer, attemptId });
    const [{ id: other }] = await db.query<{ id: string }>("INSERT INTO users (email, display_name, role) VALUES ('o@x.test', 'O', 'BUYER') RETURNING id");
    await expectCode(captureCheckout(db, pp, { userId: other, paymentOrderId: a.paymentOrderId }), "NOT_FOUND");
    await expectCode(cancelCheckout(db, { userId: other, paymentOrderId: a.paymentOrderId }), "NOT_FOUND");
  });
});

describe("PayPal webhooks", () => {
  const event = (orderId: string, id = "WH-EVT-1") =>
    JSON.stringify({ id, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP", supplementary_data: { related_ids: { order_id: orderId } } } });
  const headers = new Headers({
    "paypal-transmission-id": "t",
    "paypal-transmission-sig": "s",
    "paypal-transmission-time": "now",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://paypal.test/cert",
  });

  it("rejects a fake webhook without changing payment state", async () => {
    state.webhookValid = false;
    const pp = fakePayPal(state);
    const { attemptId } = await approvedCart();
    const a = await startCheckout(db, pp, { userId: buyer, attemptId });
    await expectCode(handleWebhook(db, pp, { headers, rawBody: event(a.paypalOrderId) }), "BAD_SIGNATURE");
    const [o] = await db.query<{ status: string }>("SELECT status FROM payment_orders WHERE id = $1", [a.paymentOrderId]);
    expect(o.status).toBe("PAYPAL_CREATED");
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_events");
    expect(n).toBe(0);
  });

  it("reconciles a verified capture webhook by re-reading the order, once", async () => {
    const pp = fakePayPal(state);
    const { attemptId } = await approvedCart();
    const a = await startCheckout(db, pp, { userId: buyer, attemptId });
    state.orders.get(a.paypalOrderId)!.captured = "TESTCAPWEBHOOK1"; // the buyer's browser closed before our capture call returned
    const first = await handleWebhook(db, pp, { headers, rawBody: event(a.paypalOrderId) });
    expect(first).toMatchObject({ handled: true, status: "CAPTURED" });
    expect(await handleWebhook(db, pp, { headers, rawBody: event(a.paypalOrderId) })).toEqual({ handled: false, duplicate: true });
  });
});

describe("Purchase Passport with passkey approvals", () => {
  it("is PASSKEY_VERIFIED when the buyer's passkey signed the terms and the cart, and fails if either proof is altered", async () => {
    const rp = { rpID: "localhost", origin: "http://localhost:3000" };
    const device = new SoftAuthenticator(rp.origin);
    const user = { id: buyer, email: "b@x.test", display_name: "B" };
    const reg = await db.tx((q) => registrationOptions(q, user, rp));
    await db.tx((q) => verifyRegistration(q, buyer, { challengeId: reg.challengeId, response: device.register(reg.options) as never, rp }));
    const sign = async (binding: Parameters<typeof approvalOptions>[3]) => {
      const { challengeId, options } = await db.tx((q) => approvalOptions(q, buyer, rp, binding));
      return { challengeId, response: device.assert(options) as never, rp };
    };

    const { id: pid } = await createPermission(db, buyer, { ...validForm(), expires_at: future });
    const r = await reviewPermission(db, buyer, pid);
    await approvePermission(db, {
      userId: buyer, sessionId: "s", permissionId: pid, termsHash: r.termsHash, signingKey,
      consents: { checked_terms: true, ai_may_err: true, no_charge_yet: true },
      passkey: await sign({ purpose: "PERMISSION_APPROVAL", policy_id: r.policyId, version: r.version, terms_hash: r.termsHash }),
    });
    const cart = await evaluateAndRecord(db, { userId: buyer, permissionId: pid, sku: "CW-SNK-RUN-WHT-M10", signingKey });
    await approveCart(db, {
      userId: buyer, attemptId: cart.id, cartHash: cart.cartHash,
      passkey: await sign({ purpose: "CART_APPROVAL", cart_attempt_id: cart.id, cart_hash: cart.cartHash }),
    });

    const pp = fakePayPal(state);
    const a = await startCheckout(db, pp, { userId: buyer, attemptId: cart.id });
    const res = await captureCheckout(db, pp, { userId: buyer, paymentOrderId: a.paymentOrderId });
    const passport = await getPassportForOwner(db, buyer, res.passportId!);
    expect(passport.bundle.assurance).toBe("PASSKEY_VERIFIED");
    expect(passport.valid).toBe(true);
    expect(passport.checks.map((c) => c.label)).toEqual(
      expect.arrayContaining(["Buyer's passkey signed these exact permission terms", "Buyer's passkey signed this exact cart"]),
    );

    // Swap in a forged cart approval (a different cart hash): the passkey check fails even before signatures.
    const forged = structuredClone(passport.signed);
    const approval = JSON.parse(forged.bundle.cart.buyer_approval!);
    approval.passkey.challenge_inputs.cart_hash = `sha256:${"2".repeat(64)}`;
    forged.bundle.cart.buyer_approval = JSON.stringify(approval);
    const checked = await verifyUploaded(db, forged);
    expect(checked.valid).toBe(false);
    expect(checked.checks.find((c) => c.label === "Buyer's passkey signed this exact cart")?.ok).toBe(false);
  });
});
