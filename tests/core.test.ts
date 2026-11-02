import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/lib/crypto/canonical.ts";
import { summarizeTerms } from "../src/lib/permissions/summary.ts";
import { validateTerms } from "../src/lib/permissions/terms.ts";
import { canonicalHash } from "../src/server/crypto/hash.ts";
import { generatePrivatePem, keyFromPrivatePem, signRecord, verifyRecord, SIGNING_DOMAINS } from "../src/server/crypto/signing.ts";
import { hashPassword, verifyPassword } from "../src/server/auth/password.ts";
import { validForm, NOW } from "./fixtures.ts";

describe("canonicalJson", () => {
  it("sorts keys recursively and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it("produces the same hash regardless of key order", () => {
    expect(canonicalHash({ x: "1.00", y: [1, 2] })).toBe(canonicalHash({ y: [1, 2], x: "1.00" }));
  });

  it("rejects values that have no stable representation", () => {
    expect(() => canonicalJson({ n: NaN })).toThrow();
    expect(() => canonicalJson({ d: new Date() })).toThrow();
  });
});

describe("validateTerms", () => {
  it("accepts the spec's example permission and normalizes money", () => {
    const r = validateTerms({ ...validForm(), max_total: "150" }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.terms.max_total).toBe("150.00");
      expect(r.terms.merchant_ids).toEqual(["DEMO-SNEAKER-STORE"]);
    }
  });

  it.each([
    ["product_type", { product_type: "anything" }],
    ["product_type", { product_type: "" }],
    ["quantity", { quantity: 0 }],
    ["quantity", { quantity: 1.5 }],
    ["max_total", { max_total: "-5" }],
    ["max_total", { max_total: "0" }],
    ["max_total", { max_total: "1e3" }],
    ["max_total", { max_total: "20000" }],
    ["merchant_ids", { merchant_ids: [] }],
    ["recurring", { recurring: true }],
    ["single_use", { single_use: false }],
    ["expires_at", { expires_at: "2026-11-01T00:00:00Z" }],
    ["expires_at", { expires_at: "2027-03-01T00:00:00Z" }],
    ["display_timezone", { display_timezone: "Mars/Olympus" }],
  ])("rejects an invalid %s", (field, patch) => {
    const r = validateTerms({ ...validForm(), ...patch }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[field]).toBeTruthy();
  });

  it("rejects a form with missing required fields", () => {
    const r = validateTerms({}, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toEqual(expect.arrayContaining(["product_type", "max_total", "merchant_ids", "expires_at"]));
  });
});

describe("summarizeTerms", () => {
  it("states the product, seller, total, deadline and checkout rule in plain English", () => {
    const r = validateTerms(validForm(), NOW);
    if (!r.ok) throw new Error("fixture invalid");
    const s = summarizeTerms(r.terms, { "DEMO-SNEAKER-STORE": "Demo Sneaker Store" });
    expect(s).toContain("ONE NEW WHITE RUNNING SHOES");
    expect(s).toContain("SIZE US M 10");
    expect(s).toContain("DEMO SNEAKER STORE");
    expect(s).toContain("NO MORE THAN $150.00 USD TOTAL");
    expect(s).toContain("GMT+5");
    expect(s).toContain("approve the final checkout separately in PayPal");
  });
});

describe("Ed25519 application signatures", () => {
  const key = keyFromPrivatePem(generatePrivatePem());

  it("verifies an untouched record and rejects a modified one", () => {
    const record = { policy_id: "CW-POL-001", version: 1, terms_hash: "sha256:abc" };
    const { signature } = signRecord(SIGNING_DOMAINS.permissionApproval, record, key);
    expect(verifyRecord(SIGNING_DOMAINS.permissionApproval, record, signature, key.publicKeyPem)).toBe(true);
    expect(verifyRecord(SIGNING_DOMAINS.permissionApproval, { ...record, version: 2 }, signature, key.publicKeyPem)).toBe(false);
  });

  it("does not accept a signature from another domain", () => {
    const record = { a: 1 };
    const { signature } = signRecord(SIGNING_DOMAINS.cart, record, key);
    expect(verifyRecord(SIGNING_DOMAINS.permissionApproval, record, signature, key.publicKeyPem)).toBe(false);
  });
});

describe("password hashing", () => {
  it("verifies the right password only", async () => {
    const h = await hashPassword("correct horse");
    expect(await verifyPassword("correct horse", h)).toBe(true);
    expect(await verifyPassword("wrong horse", h)).toBe(false);
  });
});
