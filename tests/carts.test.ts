import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { suggestProducts } from "../src/lib/policy/agent.ts";
import { priceCart } from "../src/lib/policy/engine.ts";
import type { TermsFormValues } from "../src/lib/permissions/terms.ts";
import { verifyEvidenceChain } from "../src/server/audit.ts";
import { generatePrivatePem, keyFromPrivatePem } from "../src/server/crypto/signing.ts";
import { createTestDb, type Db } from "../src/server/db/client.ts";
import { approveCart, evaluateAndRecord, getAttemptDetail, listCatalog, loadActiveVersion } from "../src/server/services/carts.ts";
import { approvePermission, createPermission, reviewPermission, revokePermission, ServiceError } from "../src/server/services/permissions.ts";
import { NOW, validForm } from "./fixtures.ts";

const signingKey = keyFromPrivatePem(generatePrivatePem());
const CONSENTS = { checked_terms: true, ai_may_err: true, no_charge_yet: true };

let db: Db;
let buyer: string;

async function activePermission(overrides: Partial<TermsFormValues> = {}) {
  const { id } = await createPermission(db, buyer, { ...validForm(), ...overrides });
  const r = await reviewPermission(db, buyer, id, NOW);
  await approvePermission(db, { userId: buyer, sessionId: "s", permissionId: id, termsHash: r.termsHash, consents: CONSENTS, now: NOW, signingKey });
  return id;
}

const check = (permissionId: string, sku: string, quantity?: number) =>
  evaluateAndRecord(db, { userId: buyer, permissionId, sku, quantity, now: NOW, signingKey });

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ServiceError && e.code === code);
}

beforeEach(async () => {
  db = await createTestDb();
  const [u] = await db.query<{ id: string }>("INSERT INTO users (email, display_name, role) VALUES ('b@x.test', 'B', 'BUYER') RETURNING id");
  buyer = u.id;
});
afterEach(async () => db.close());

describe("pricing", () => {
  it("computes the final total in integer cents, tax rounded half-up", () => {
    expect(priceCart({ unitPrice: "105.00", quantity: 1, shipping: "8.70", taxRateBps: 600 })).toEqual({
      subtotal: "105.00",
      shipping: "8.70",
      tax: "6.30",
      total: "120.00",
    });
    expect(priceCart({ unitPrice: "0.10", quantity: 3, shipping: "0.00", taxRateBps: 250 }).tax).toBe("0.01");
  });
});

describe("spec demonstration matrix", () => {
  it("ALLOWs matching white size-10 shoes for $120 total", async () => {
    const pid = await activePermission();
    const r = await check(pid, "CW-SNK-RUN-WHT-M10");
    expect(r.verdict).toBe("ALLOW");
    expect(r.mismatchCodes).toEqual([]);
  });

  it("BLOCKs $149 + $12 shipping against a $150 total limit", async () => {
    const pid = await activePermission();
    const r = await check(pid, "CW-SNK-RUN-WHT-M10-PRO");
    expect(r.verdict).toBe("BLOCK");
    expect(r.mismatchCodes).toEqual(["TOTAL"]);
    const d = await getAttemptDetail(db, buyer, r.id, NOW);
    expect(d.rules.find((x) => x.code === "TOTAL")?.message).toBe("Final total is $11.00 USD over your limit.");
  });

  it.each([
    ["size 9", "CW-SNK-RUN-WHT-M9", ["SIZE"]],
    ["black instead of white", "CW-SNK-RUN-BLK-M10", ["COLOR"]],
    ["refurbished", "CW-SNK-RUN-WHT-M10-REF", ["CONDITION"]],
    ["a seller not on the allowlist", "CW-OUT-RUN-WHT-M10", ["SELLER"]],
    ["out of stock", "CW-SNK-RUN-WHT-M10-OOS", ["AVAILABILITY"]],
    ["a subscription", "CW-SNK-CARE-SUB", ["PRODUCT_TYPE", "RECURRING"]],
  ])("BLOCKs %s", async (_label, sku, codes) => {
    const pid = await activePermission();
    const r = await check(pid, sku);
    expect(r.verdict).toBe("BLOCK");
    expect(r.mismatchCodes).toEqual(expect.arrayContaining(codes));
  });

  it("BLOCKs a look-alike seller with the same display name and explains why", async () => {
    const pid = await activePermission();
    const r = await check(pid, "CW-LKA-RUN-WHT-M10");
    expect(r.verdict).toBe("BLOCK");
    const d = await getAttemptDetail(db, buyer, r.id, NOW);
    expect(d.rules.find((x) => x.code === "SELLER")?.message).toMatch(/Look-alike seller/);
  });

  it("is not swayed by a prompt-injection product description", async () => {
    const pid = await activePermission();
    const r = await check(pid, "CW-SNK-RUN-WHT-M10-INJ");
    expect(r.verdict).toBe("BLOCK");
    expect(r.mismatchCodes).toEqual(["TOTAL"]);
  });

  it("REVIEWs an ambiguous colour", async () => {
    const pid = await activePermission();
    const r = await check(pid, "CW-SNK-RUN-OFW-M10");
    expect(r.verdict).toBe("REVIEW");
    expect(r.mismatchCodes).toEqual(["COLOR"]);
  });

  it("REVIEWs missing variant data and unknown authenticity — never auto-allows", async () => {
    const pid = await activePermission();
    const r = await check(pid, "CW-SNK-RUN-WHT-NOSIZE");
    expect(r.verdict).toBe("REVIEW");
    expect(r.mismatchCodes).toEqual(expect.arrayContaining(["SIZE", "AUTHENTICITY"]));
  });

  it("REVIEWs a different brand when substitutions are 'ask first', BLOCKs it when not allowed", async () => {
    const ask = await activePermission({ brand: "Strideline", substitutions: "ASK_FIRST" });
    expect((await check(ask, "CW-SNK-RUN-KES-M10")).verdict).toBe("REVIEW");
    const strict = await activePermission({ brand: "Strideline", substitutions: "NOT_ALLOWED" });
    expect((await check(strict, "CW-SNK-RUN-KES-M10")).verdict).toBe("BLOCK");
  });

  it("BLOCKs more items than allowed", async () => {
    const pid = await activePermission();
    const r = await check(pid, "CW-SNK-RUN-WHT-M10", 2);
    expect(r.mismatchCodes).toContain("QUANTITY");
  });

  it("BLOCKs every cart once the permission is revoked or expired", async () => {
    const pid = await activePermission();
    await revokePermission(db, buyer, pid, NOW);
    const revoked = await check(pid, "CW-SNK-RUN-WHT-M10");
    expect(revoked).toMatchObject({ verdict: "BLOCK", mismatchCodes: ["PERMISSION_STATUS"] });

    const pid2 = await activePermission();
    const late = await evaluateAndRecord(db, { userId: buyer, permissionId: pid2, sku: "CW-SNK-RUN-WHT-M10", now: new Date("2026-11-07T00:00:00Z"), signingKey });
    expect(late.verdict).toBe("BLOCK");
    expect(late.mismatchCodes).toEqual(expect.arrayContaining(["PERMISSION_STATUS", "DEADLINE"]));
  });
});

describe("recorded evaluations", () => {
  it("are signed, intact and chained into the evidence log", async () => {
    const pid = await activePermission();
    const r = await check(pid, "CW-SNK-RUN-WHT-M10");
    const d = await getAttemptDetail(db, buyer, r.id, NOW);
    expect(d.integrity).toEqual({ cartIntact: true, evaluationIntact: true, signatureValid: true });
    expect(d.cart.total).toBe("120.00");
    expect(await verifyEvidenceChain(db)).toMatchObject({ ok: true });
  });

  it("cannot be rewritten, and tampering is detected", async () => {
    const pid = await activePermission();
    const r = await check(pid, "CW-SNK-RUN-WHT-M10-PRO");
    await expect(db.query("UPDATE cart_attempts SET verdict = 'ALLOW'")).rejects.toThrow(/CW_IMMUTABLE/);
    await expect(db.query("DELETE FROM cart_attempts")).rejects.toThrow(/CW_IMMUTABLE/);
    await db.exec("ALTER TABLE cart_attempts DISABLE TRIGGER cart_attempts_guard");
    await db.query("UPDATE cart_attempts SET verdict = 'ALLOW', cart_json = replace(cart_json, '161.00', '149.00')");
    const d = await getAttemptDetail(db, buyer, r.id, NOW);
    expect(d.integrity.cartIntact).toBe(false);
    expect(d.integrity.evaluationIntact).toBe(false);
  });

  it("are private to their buyer", async () => {
    const pid = await activePermission();
    const r = await check(pid, "CW-SNK-RUN-WHT-M10");
    const [other] = await db.query<{ id: string }>("INSERT INTO users (email, display_name, role) VALUES ('o@x.test', 'O', 'BUYER') RETURNING id");
    await expectCode(getAttemptDetail(db, other.id, r.id, NOW), "NOT_FOUND");
    await expectCode(evaluateAndRecord(db, { userId: other.id, permissionId: pid, sku: "CW-SNK-RUN-WHT-M10", now: NOW, signingKey }), "NOT_FOUND");
  });
});

describe("buyer cart approval", () => {
  it("approves the exact allowed cart once (idempotent)", async () => {
    const pid = await activePermission();
    const r = await check(pid, "CW-SNK-RUN-WHT-M10");
    const first = await approveCart(db, { userId: buyer, attemptId: r.id, cartHash: r.cartHash, now: NOW });
    const again = await approveCart(db, { userId: buyer, attemptId: r.id, cartHash: r.cartHash, now: NOW });
    expect(first.alreadyApproved).toBe(false);
    expect(again).toEqual({ approvedAt: first.approvedAt, alreadyApproved: true });
  });

  it("refuses blocked carts and wrong hashes", async () => {
    const pid = await activePermission();
    const blocked = await check(pid, "CW-SNK-RUN-WHT-M9");
    await expectCode(approveCart(db, { userId: buyer, attemptId: blocked.id, cartHash: blocked.cartHash, now: NOW }), "NOT_ALLOWED");
    const ok = await check(pid, "CW-SNK-RUN-WHT-M10");
    await expectCode(approveCart(db, { userId: buyer, attemptId: ok.id, cartHash: "sha256:" + "0".repeat(64), now: NOW }), "CART_CHANGED");
  });

  it("detects a price change after the check and requires a new check", async () => {
    const pid = await activePermission();
    const r = await check(pid, "CW-SNK-RUN-WHT-M10");
    await db.query("UPDATE catalog_products SET price = 109.00 WHERE sku = 'CW-SNK-RUN-WHT-M10'");
    await expectCode(approveCart(db, { userId: buyer, attemptId: r.id, cartHash: r.cartHash, now: NOW }), "CART_CHANGED");
    expect((await getAttemptDetail(db, buyer, r.id, NOW)).stillCurrent).toBe(false);
    const fresh = await check(pid, "CW-SNK-RUN-WHT-M10");
    expect(fresh.cartHash).not.toBe(r.cartHash);
  });

  it("refuses approval after the permission is revoked", async () => {
    const pid = await activePermission();
    const r = await check(pid, "CW-SNK-RUN-WHT-M10");
    await revokePermission(db, buyer, pid, NOW);
    await expectCode(approveCart(db, { userId: buyer, attemptId: r.id, cartHash: r.cartHash, now: NOW }), "REVOKED");
  });
});

describe("demo shopping agent", () => {
  it("ranks relevant products with reasons, and can be fooled — which the policy gate catches", async () => {
    const pid = await activePermission();
    const { terms } = await loadActiveVersion(db, buyer, pid);
    const picks = suggestProducts(terms, await listCatalog(db), 5);
    expect(picks[0].sku).toBe("CW-SNK-RUN-WHT-M10");
    expect(picks[0].reasons).toEqual(expect.arrayContaining(["Matches “running shoes”", "Size US M 10"]));
    expect(picks.map((p) => p.sku)).not.toContain("CW-SNK-CARE-SUB");
    // The cheap look-alike seller looks attractive to a naive agent...
    expect(picks.map((p) => p.sku)).toContain("CW-LKA-RUN-WHT-M10");
    // ...but the deterministic gate blocks it.
    expect((await check(pid, "CW-LKA-RUN-WHT-M10")).verdict).toBe("BLOCK");
  });
});
