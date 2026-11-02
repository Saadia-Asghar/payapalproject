// Purchase Passport: one signed proof bundle per captured purchase, linking the approved
// permission version, the exact evaluated cart, the buyer's cart approval and the PayPal IDs.
// Issued only from recordCapture() after PayPal's server response was verified.
import { canonicalJson } from "../../lib/crypto/canonical.ts";
import { appendEvidence, verifyEvidenceChain } from "../audit.ts";
import { canonicalHash } from "../crypto/hash.ts";
import { getSigningKey, signRecord, verifyRecord, SIGNING_DOMAINS, type SigningKey } from "../crypto/signing.ts";
import type { Queryable } from "../db/client.ts";
import { ServiceError } from "./permissions.ts";

export const PASSPORT_SCHEMA_ID = "cartwitness.passport.v1";

export interface PassportBundle {
  schema: typeof PASSPORT_SCHEMA_ID;
  passport_id: string;
  issued_at: string;
  assurance: "APPLICATION_SIGNED";
  permission: { policy_id: string; version: number; terms_hash: string; approval_record: string; approval_signature: string; approval_key_id: string };
  cart: {
    cart_hash: string;
    evaluation_record: string;
    evaluation_signature: string;
    evaluation_key_id: string;
    verdict: string;
    buyer_cart_approved_at: string;
  };
  merchant: { id: string; display_name: string };
  payment: {
    environment: "PAYPAL_SANDBOX";
    reconciliation_key: string;
    paypal_order_id: string;
    paypal_capture_id: string;
    amount: string;
    currency: string;
    capture_status: string;
    response_sha256: string;
  };
  audit_head: string;
}

export interface SignedPassport {
  bundle: PassportBundle;
  signature: string;
  signing_key_id: string;
}

const PASSPORT_ID_RE = /^CW-PP-\d{5,}$/;

/** Builds, signs and stores the passport. Must run inside the capture transaction. */
export async function issuePassport(q: Queryable, paymentOrderId: string, now: Date, key: SigningKey = getSigningKey()): Promise<string> {
  const [row] = await q.query<{
    user_id: string;
    reconciliation_key: string;
    paypal_order_id: string;
    paypal_capture_id: string;
    capture_status: string;
    amount: string;
    currency: string;
    response_hash: string;
    cart_json: string;
    cart_hash: string;
    verdict: string;
    evaluation_record: string;
    eval_signature: string;
    eval_key: string;
    buyer_cart_approved_at: Date;
    policy_id: string;
    version: number;
    terms_hash: string;
    approval_record: string;
    approval_signature: string;
    approval_key: string;
  }>(
    `SELECT o.user_id, o.reconciliation_key, o.paypal_order_id, c.paypal_capture_id, c.status AS capture_status,
            c.amount::text AS amount, c.currency, c.response_hash,
            a.cart_json, a.cart_hash, a.verdict, a.evaluation_record, a.signature AS eval_signature, a.signing_key_id AS eval_key,
            a.buyer_cart_approved_at, p.public_id AS policy_id, v.version, v.terms_hash, v.approval_record,
            v.signature AS approval_signature, v.signing_key_id AS approval_key
       FROM payment_orders o
       JOIN payment_captures c ON c.payment_order_id = o.id
       JOIN cart_attempts a ON a.id = o.cart_attempt_id
       JOIN permission_versions v ON v.id = a.permission_version_id
       JOIN permissions p ON p.id = v.permission_id
      WHERE o.id = $1`,
    [paymentOrderId],
  );
  if (!row) throw new ServiceError("NOT_CAPTURED", 409, "No verified capture for this order.");
  const cart = JSON.parse(row.cart_json) as { merchant: { id: string; display_name: string } };
  const [{ id }] = await q.query<{ id: string }>("SELECT 'CW-PP-' || lpad(nextval('passport_seq')::text, 5, '0') AS id");
  const [head] = await q.query<{ hash: string }>("SELECT hash FROM evidence_events ORDER BY seq DESC LIMIT 1");

  const bundle: PassportBundle = {
    schema: PASSPORT_SCHEMA_ID,
    passport_id: id,
    issued_at: now.toISOString(),
    assurance: "APPLICATION_SIGNED",
    permission: {
      policy_id: row.policy_id,
      version: row.version,
      terms_hash: row.terms_hash,
      approval_record: row.approval_record,
      approval_signature: row.approval_signature,
      approval_key_id: row.approval_key,
    },
    cart: {
      cart_hash: row.cart_hash,
      evaluation_record: row.evaluation_record,
      evaluation_signature: row.eval_signature,
      evaluation_key_id: row.eval_key,
      verdict: row.verdict,
      buyer_cart_approved_at: new Date(row.buyer_cart_approved_at).toISOString(),
    },
    merchant: cart.merchant,
    payment: {
      environment: "PAYPAL_SANDBOX",
      reconciliation_key: row.reconciliation_key,
      paypal_order_id: row.paypal_order_id,
      paypal_capture_id: row.paypal_capture_id,
      amount: row.amount,
      currency: row.currency,
      capture_status: row.capture_status,
      response_sha256: row.response_hash,
    },
    audit_head: head.hash,
  };
  const { signature, keyId } = signRecord(SIGNING_DOMAINS.passport, bundle, key);
  await q.query("INSERT INTO signing_keys (key_id, public_key_pem) VALUES ($1, $2) ON CONFLICT (key_id) DO NOTHING", [keyId, key.publicKeyPem]);
  await q.query(
    `INSERT INTO passports (id, payment_order_id, user_id, bundle_json, bundle_hash, signature, signing_key_id, issued_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, paymentOrderId, row.user_id, canonicalJson(bundle), canonicalHash(bundle), signature, keyId, now.toISOString()],
  );
  await appendEvidence(q, {
    subjectType: "passport",
    subjectId: id,
    eventType: "PASSPORT_ISSUED",
    actorId: row.user_id,
    payload: { payment_order_id: paymentOrderId, bundle_hash: canonicalHash(bundle) },
    at: now,
  });
  return id;
}

export interface VerificationCheck {
  label: string;
  ok: boolean;
}

/**
 * Verifies a passport bundle using only public keys: the passport signature, the embedded
 * permission-approval and cart-evaluation signatures, and that they reference each other.
 */
export function verifyPassportBundle(input: unknown, signature: unknown, keyId: unknown, keys: Record<string, string>): VerificationCheck[] {
  const b = input as Partial<PassportBundle> | null;
  const checks: VerificationCheck[] = [];
  const add = (label: string, fn: () => boolean) => {
    let ok = false;
    try {
      ok = fn();
    } catch {
      ok = false;
    }
    checks.push({ label, ok });
  };
  add("Bundle format is a CartWitness passport", () => !!b && b.schema === PASSPORT_SCHEMA_ID && PASSPORT_ID_RE.test(String(b.passport_id)));
  add("Passport signature matches its contents", () =>
    typeof signature === "string" && typeof keyId === "string" && !!keys[keyId] && verifyRecord(SIGNING_DOMAINS.passport, b, signature, keys[keyId]),
  );
  add("Buyer's permission approval signature is valid", () => {
    const p = b!.permission!;
    return !!keys[p.approval_key_id] && verifyRecord(SIGNING_DOMAINS.permissionApproval, JSON.parse(p.approval_record), p.approval_signature, keys[p.approval_key_id]);
  });
  add("Approval record covers these exact permission terms", () => {
    const rec = JSON.parse(b!.permission!.approval_record) as { terms_hash: string; policy_id: string; version: number };
    return rec.terms_hash === b!.permission!.terms_hash && rec.policy_id === b!.permission!.policy_id && rec.version === b!.permission!.version;
  });
  add("Cart evaluation signature is valid", () => {
    const c = b!.cart!;
    return !!keys[c.evaluation_key_id] && verifyRecord(SIGNING_DOMAINS.cart, JSON.parse(c.evaluation_record), c.evaluation_signature, keys[c.evaluation_key_id]);
  });
  add("The paid cart was checked against this permission version and allowed", () => {
    const rec = JSON.parse(b!.cart!.evaluation_record) as { cart_hash: string; terms_hash: string; verdict: string; policy_id: string; permission_version: number };
    return (
      rec.cart_hash === b!.cart!.cart_hash &&
      rec.terms_hash === b!.permission!.terms_hash &&
      rec.verdict === "ALLOW" &&
      b!.cart!.verdict === "ALLOW" &&
      rec.policy_id === b!.permission!.policy_id &&
      rec.permission_version === b!.permission!.version
    );
  });
  add("PayPal capture recorded as completed", () => b!.payment!.capture_status === "COMPLETED" && !!b!.payment!.paypal_capture_id);
  return checks;
}

async function publicKeys(q: Queryable) {
  const rows = await q.query<{ key_id: string; public_key_pem: string }>("SELECT key_id, public_key_pem FROM signing_keys");
  return Object.fromEntries(rows.map((r) => [r.key_id, r.public_key_pem]));
}

interface PassportRow {
  id: string;
  payment_order_id: string;
  user_id: string;
  bundle_json: string;
  bundle_hash: string;
  signature: string;
  signing_key_id: string;
  issued_at: Date;
}

async function loadPassport(q: Queryable, passportId: string) {
  if (!PASSPORT_ID_RE.test(passportId)) return null;
  const [row] = await q.query<PassportRow>("SELECT * FROM passports WHERE id = $1", [passportId]);
  return row ?? null;
}

/** Full check of a stored passport: signatures plus cross-checks against the live database. */
async function verifyStored(q: Queryable, row: PassportRow) {
  const bundle = JSON.parse(row.bundle_json) as PassportBundle;
  const checks = verifyPassportBundle(bundle, row.signature, row.signing_key_id, await publicKeys(q));
  const [db] = await q.query<{ terms_hash: string; cart_hash: string; capture_id: string; amount: string }>(
    `SELECT v.terms_hash, a.cart_hash, c.paypal_capture_id AS capture_id, c.amount::text AS amount
       FROM payment_orders o
       JOIN payment_captures c ON c.payment_order_id = o.id
       JOIN cart_attempts a ON a.id = o.cart_attempt_id
       JOIN permission_versions v ON v.id = a.permission_version_id
      WHERE o.id = $1`,
    [row.payment_order_id],
  );
  checks.push({
    label: "Server records still match the passport (terms, cart, capture, amount)",
    ok:
      canonicalHash(bundle) === row.bundle_hash &&
      !!db &&
      db.terms_hash === bundle.permission.terms_hash &&
      db.cart_hash === bundle.cart.cart_hash &&
      db.capture_id === bundle.payment.paypal_capture_id &&
      db.amount === bundle.payment.amount,
  });
  const chain = await verifyEvidenceChain(q);
  checks.push({ label: "Audit log hash chain is intact", ok: chain.ok });
  return { bundle, checks, valid: checks.every((c) => c.ok) };
}

/** Owner view: the full signed bundle (downloadable) and every check. */
export async function getPassportForOwner(q: Queryable, userId: string, passportId: string) {
  const row = await loadPassport(q, passportId);
  if (!row || row.user_id !== userId) throw new ServiceError("NOT_FOUND", 404, "Passport not found.");
  const result = await verifyStored(q, row);
  return { ...result, signed: { bundle: result.bundle, signature: row.signature, signing_key_id: row.signing_key_id } satisfies SignedPassport };
}

export async function listPassportsForUser(q: Queryable, userId: string) {
  return q.query<{ id: string; issued_at: Date; amount: string; merchant: string; policy_id: string }>(
    `SELECT id, issued_at, bundle_json::jsonb -> 'payment' ->> 'amount' AS amount,
            bundle_json::jsonb -> 'merchant' ->> 'display_name' AS merchant,
            bundle_json::jsonb -> 'permission' ->> 'policy_id' AS policy_id
       FROM passports WHERE user_id = $1 ORDER BY issued_at DESC`,
    [userId],
  );
}

/** Public, redacted result: yes/no plus non-personal facts. No buyer, product or address data. */
export async function publicVerify(q: Queryable, passportId: string) {
  const row = await loadPassport(q, passportId);
  if (!row) return { found: false as const, passport_id: passportId };
  const { bundle, checks, valid } = await verifyStored(q, row);
  return {
    found: true as const,
    passport_id: row.id,
    valid,
    verification: "SERVER_VERIFIED" as const,
    checks,
    summary: {
      issued_at: bundle.issued_at,
      policy: `${bundle.permission.policy_id} v${bundle.permission.version}`,
      merchant: bundle.merchant.display_name,
      amount: `${bundle.payment.amount} ${bundle.payment.currency}`,
      payment: "PayPal sandbox capture completed",
      verdict: bundle.cart.verdict,
    },
  };
}

/** Verifies a bundle someone pasted or uploaded (e.g. to show that editing it breaks verification). */
export async function verifyUploaded(q: Queryable, signed: unknown) {
  const s = signed as Partial<SignedPassport> | null;
  const checks = verifyPassportBundle(s?.bundle, s?.signature, s?.signing_key_id, await publicKeys(q));
  return { valid: checks.every((c) => c.ok), verification: "SERVER_VERIFIED" as const, checks };
}
