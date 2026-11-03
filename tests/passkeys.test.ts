// Passkey (WebAuthn) approvals: buyer-bound signatures over exact terms and exact carts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approvalOptions,
  registrationOptions,
  signInOptions,
  verifyPasskeyProof,
  verifyRegistration,
  verifySignIn,
  type PasskeyApprovalInput,
  type PasskeyProof,
} from "../src/server/auth/webauthn.ts";
import { generatePrivatePem, keyFromPrivatePem } from "../src/server/crypto/signing.ts";
import { createTestDb, type Db } from "../src/server/db/client.ts";
import { createDemoBuyer, ensureDemoMerchant } from "../src/server/seed.ts";
import { approveCart, evaluateAndRecord } from "../src/server/services/carts.ts";
import { approvePermission, createPermission, getPermissionDetail, reviewPermission, ServiceError } from "../src/server/services/permissions.ts";
import { validForm } from "./fixtures.ts";
import { SoftAuthenticator } from "./soft-authenticator.ts";

const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
const signingKey = keyFromPrivatePem(generatePrivatePem());
const rp = { rpID: "localhost", origin: "http://localhost:3000" };
const consents = { checked_terms: true, ai_may_err: true, no_charge_yet: true };

let db: Db;
let buyer: { id: string; email: string; display_name: string };
let device: SoftAuthenticator;

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ServiceError && e.code === code);
}

async function addPasskey(userId = buyer.id, auth = device) {
  const { challengeId, options } = await db.tx((q) => registrationOptions(q, { ...buyer, id: userId }, rp));
  return db.tx((q) => verifyRegistration(q, userId, { challengeId, response: auth.register(options) as never, rp }));
}

/** What the browser does: fetch options bound to the data, then let the authenticator sign them. */
async function sign(binding: Parameters<typeof approvalOptions>[3], auth = device): Promise<PasskeyApprovalInput> {
  const { challengeId, options } = await db.tx((q) => approvalOptions(q, buyer.id, rp, binding));
  return { challengeId, response: auth.assert(options) as never, rp };
}

async function reviewed() {
  const { id } = await createPermission(db, buyer.id, { ...validForm(), expires_at: future });
  return { id, review: await reviewPermission(db, buyer.id, id) };
}

const permBinding = (r: Awaited<ReturnType<typeof reviewPermission>>) =>
  ({ purpose: "PERMISSION_APPROVAL", policy_id: r.policyId, version: r.version, terms_hash: r.termsHash }) as const;

beforeEach(async () => {
  db = await createTestDb();
  [buyer] = await db.query<typeof buyer>("INSERT INTO users (email, display_name, role) VALUES ('b@x.test', 'B', 'BUYER') RETURNING id, email, display_name");
  device = new SoftAuthenticator(rp.origin);
});
afterEach(async () => db.close());

describe("passkey registration and sign-in", () => {
  it("registers a passkey and signs in with it without a username", async () => {
    await addPasskey();
    const { challengeId, options } = await db.tx((q) => signInOptions(q, rp));
    expect(await db.tx((q) => verifySignIn(q, { challengeId, response: device.assert(options) as never, rp }))).toBe(buyer.id);
  });

  it("rejects a registration for another site or without user verification", async () => {
    const other = new SoftAuthenticator("https://evil.example");
    await expectCode(addPasskey(buyer.id, other), "PASSKEY_FAILED");
    device.userVerified = false;
    await expectCode(addPasskey(), "PASSKEY_FAILED");
  });

  it("does not sign in with an unregistered passkey, or replay a sign-in challenge", async () => {
    await addPasskey();
    const { challengeId, options } = await db.tx((q) => signInOptions(q, rp));
    const stranger = new SoftAuthenticator(rp.origin);
    await expectCode(db.tx((q) => verifySignIn(q, { challengeId, response: stranger.assert(options) as never, rp })), "PASSKEY_UNKNOWN");
    const second = await db.tx((q) => signInOptions(q, rp));
    const response = device.assert(second.options) as never;
    await db.tx((q) => verifySignIn(q, { challengeId: second.challengeId, response, rp }));
    await expectCode(db.tx((q) => verifySignIn(q, { challengeId: second.challengeId, response, rp })), "PASSKEY_CHALLENGE");
  });
});

describe("passkey-approved permissions", () => {
  it("binds the approval to the exact terms and stores a re-verifiable proof", async () => {
    await addPasskey();
    const { id, review } = await reviewed();
    const res = await approvePermission(db, {
      userId: buyer.id, sessionId: "s", permissionId: id, termsHash: review.termsHash, consents, signingKey,
      passkey: await sign(permBinding(review)),
    });
    expect(res.assurance).toBe("PASSKEY_VERIFIED");

    const detail = await getPermissionDetail(db, buyer.id, id);
    expect(detail.active?.integrity).toEqual({ termsIntact: true, signatureValid: true, passkeyValid: true });
    const proof = (JSON.parse(detail.active!.approval_record) as { passkey: PasskeyProof }).passkey;
    expect(proof.challenge_inputs).toMatchObject({ purpose: "PERMISSION_APPROVAL", terms_hash: review.termsHash });

    // The proof does not verify for any other terms, and editing the stored proof breaks it.
    expect(await verifyPasskeyProof(proof, { ...permBinding(review), terms_hash: `sha256:${"0".repeat(64)}` })).toBe(false);
    expect(await verifyPasskeyProof({ ...proof, challenge_inputs: { ...proof.challenge_inputs, version: 2 } }, { ...permBinding(review), version: 2 })).toBe(false);
  });

  it("requires the passkey once the account has one (no downgrade to session-only)", async () => {
    await addPasskey();
    const { id, review } = await reviewed();
    await expectCode(approvePermission(db, { userId: buyer.id, sessionId: "s", permissionId: id, termsHash: review.termsHash, consents, signingKey }), "PASSKEY_REQUIRED");
  });

  it("rejects a passkey signature made for other data or by another device", async () => {
    await addPasskey();
    const { id, review } = await reviewed();
    const approve = (passkey: PasskeyApprovalInput) =>
      approvePermission(db, { userId: buyer.id, sessionId: "s", permissionId: id, termsHash: review.termsHash, consents, signingKey, passkey });

    await expectCode(approve(await sign({ ...permBinding(review), terms_hash: `sha256:${"1".repeat(64)}` })), "PASSKEY_MISMATCH");
    const stranger = new SoftAuthenticator(rp.origin);
    await expectCode(approve(await sign(permBinding(review), stranger)), "PASSKEY_UNKNOWN");
    expect((await approve(await sign(permBinding(review)))).assurance).toBe("PASSKEY_VERIFIED");
  });

  it("still allows a clearly labelled application-signed approval for accounts without a passkey", async () => {
    const { id, review } = await reviewed();
    const res = await approvePermission(db, { userId: buyer.id, sessionId: "s", permissionId: id, termsHash: review.termsHash, consents, signingKey });
    expect(res.assurance).toBe("APPLICATION_SIGNED");
    expect((await getPermissionDetail(db, buyer.id, id)).active?.integrity.passkeyValid).toBeNull();
  });
});

describe("passkey-approved carts", () => {
  it("signs the exact cart hash and refuses a cart signature for a different cart", async () => {
    await addPasskey();
    const { id, review } = await reviewed();
    await approvePermission(db, { userId: buyer.id, sessionId: "s", permissionId: id, termsHash: review.termsHash, consents, signingKey, passkey: await sign(permBinding(review)) });
    const cart = await evaluateAndRecord(db, { userId: buyer.id, permissionId: id, sku: "CW-SNK-RUN-WHT-M10", signingKey });
    const other = await evaluateAndRecord(db, { userId: buyer.id, permissionId: id, sku: "CW-SNK-RUN-WHT-M10", signingKey });

    await expectCode(approveCart(db, { userId: buyer.id, attemptId: cart.id, cartHash: cart.cartHash }), "PASSKEY_REQUIRED");
    const forOther = await sign({ purpose: "CART_APPROVAL", cart_attempt_id: other.id, cart_hash: other.cartHash });
    await expectCode(approveCart(db, { userId: buyer.id, attemptId: cart.id, cartHash: cart.cartHash, passkey: forOther }), "PASSKEY_MISMATCH");

    const res = await approveCart(db, {
      userId: buyer.id, attemptId: cart.id, cartHash: cart.cartHash,
      passkey: await sign({ purpose: "CART_APPROVAL", cart_attempt_id: cart.id, cart_hash: cart.cartHash }),
    });
    expect(res.assurance).toBe("PASSKEY_VERIFIED");
    const [row] = await db.query<{ buyer_cart_approval: string }>("SELECT buyer_cart_approval FROM cart_attempts WHERE id = $1", [cart.id]);
    const stored = JSON.parse(row.buyer_cart_approval) as { passkey: PasskeyProof };
    expect(await verifyPasskeyProof(stored.passkey, { purpose: "CART_APPROVAL", cart_attempt_id: cart.id, cart_hash: cart.cartHash })).toBe(true);
    // The approval is immutable once recorded.
    await expect(db.query("UPDATE cart_attempts SET buyer_cart_approval = NULL WHERE id = $1", [cart.id])).rejects.toThrow(/CW_IMMUTABLE/);
  });
});

describe("one-click demo accounts", () => {
  it("creates a fresh private buyer each time and a shared demo merchant linked to its store", async () => {
    const a = await createDemoBuyer(db);
    const b = await createDemoBuyer(db);
    expect(a.id).not.toBe(b.id);
    const [{ is_demo, password_hash }] = await db.query<{ is_demo: boolean; password_hash: string | null }>("SELECT is_demo, password_hash FROM users WHERE id = $1", [a.id]);
    expect(is_demo).toBe(true);
    expect(password_hash).toBeNull();
    const m1 = await ensureDemoMerchant(db);
    expect(await ensureDemoMerchant(db)).toBe(m1);
    const [store] = await db.query<{ owner_user_id: string }>("SELECT owner_user_id FROM merchants WHERE id = 'DEMO-SNEAKER-STORE'");
    expect(store.owner_user_id).toBe(m1);
  });
});
