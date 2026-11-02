import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivatePem, keyFromPrivatePem } from "../src/server/crypto/signing.ts";
import { createTestDb, type Db } from "../src/server/db/client.ts";
import { approveCart, evaluateAndRecord, getAttemptDetail } from "../src/server/services/carts.ts";
import { listOwnCatalog, updateProduct } from "../src/server/services/catalog.ts";
import { reserveCheckout } from "../src/server/services/payments.ts";
import { approvePermission, createPermission, reviewPermission, ServiceError } from "../src/server/services/permissions.ts";
import { NOW, validForm } from "./fixtures.ts";

const signingKey = keyFromPrivatePem(generatePrivatePem());
let db: Db;
let buyer: string;
let merchant: string;

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ServiceError && e.code === code);
}

beforeEach(async () => {
  db = await createTestDb();
  [{ id: buyer }] = await db.query<{ id: string }>("INSERT INTO users (email, display_name, role) VALUES ('b@x.test', 'B', 'BUYER') RETURNING id");
  [{ id: merchant }] = await db.query<{ id: string }>("INSERT INTO users (email, display_name, role) VALUES ('m@x.test', 'M', 'MERCHANT') RETURNING id");
  await db.query("UPDATE merchants SET owner_user_id = $1 WHERE id = 'DEMO-SNEAKER-STORE'", [merchant]);
});
afterEach(async () => db.close());

describe("merchant catalog editing", () => {
  it("lists only the merchant's own products", async () => {
    const rows = await listOwnCatalog(db, merchant);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.every((r) => r.merchant_id === "DEMO-SNEAKER-STORE")).toBe(true);
    expect(await listOwnCatalog(db, buyer)).toEqual([]);
  });

  it("rejects other merchants' products and invalid values", async () => {
    await expectCode(updateProduct(db, { userId: merchant, sku: "CW-OUT-RUN-WHT-M10", update: { price: "1", shipping: "0", stock: 1 } }), "NOT_FOUND");
    await expectCode(updateProduct(db, { userId: merchant, sku: "CW-SNK-RUN-WHT-M10", update: { price: "-1", shipping: "0", stock: 1 } }), "BAD_REQUEST");
    await expectCode(
      updateProduct(db, { userId: merchant, sku: "CW-SNK-RUN-WHT-M10", update: { price: "1", shipping: "0", stock: 1, title: "x" } }),
      "BAD_REQUEST",
    );
  });

  it("a price rise after the buyer approved the cart invalidates that approval end to end", async () => {
    const { id: pid } = await createPermission(db, buyer, validForm());
    const r = await reviewPermission(db, buyer, pid, NOW);
    await approvePermission(db, {
      userId: buyer,
      sessionId: "s",
      permissionId: pid,
      termsHash: r.termsHash,
      consents: { checked_terms: true, ai_may_err: true, no_charge_yet: true },
      now: NOW,
      signingKey,
    });
    const cart = await evaluateAndRecord(db, { userId: buyer, permissionId: pid, sku: "CW-SNK-RUN-WHT-M10", now: NOW, signingKey });
    await approveCart(db, { userId: buyer, attemptId: cart.id, cartHash: cart.cartHash, now: NOW });

    const res = await updateProduct(db, { userId: merchant, sku: "CW-SNK-RUN-WHT-M10", update: { price: "139", shipping: "8.70", stock: 12 }, now: NOW });
    expect(res).toMatchObject({ changed: true, before: { price: "105.00" }, after: { price: "139.00" } });

    expect((await getAttemptDetail(db, buyer, cart.id, NOW)).stillCurrent).toBe(false);
    await expectCode(reserveCheckout(db, { userId: buyer, attemptId: cart.id, now: NOW }), "CART_CHANGED");
    const fresh = await evaluateAndRecord(db, { userId: buyer, permissionId: pid, sku: "CW-SNK-RUN-WHT-M10", now: NOW, signingKey });
    expect(fresh).toMatchObject({ verdict: "BLOCK", mismatchCodes: ["TOTAL"] });

    const [ev] = await db.query<{ event_type: string }>("SELECT event_type FROM evidence_events WHERE subject_id = 'CW-SNK-RUN-WHT-M10'");
    expect(ev.event_type).toBe("CATALOG_PRODUCT_CHANGED");
  });

  it("is a no-op when nothing changed", async () => {
    const r = await updateProduct(db, { userId: merchant, sku: "CW-SNK-RUN-WHT-M10", update: { price: "105.00", shipping: "8.7", stock: 12 } });
    expect(r.changed).toBe(false);
  });
});
