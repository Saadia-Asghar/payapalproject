// Cart attempts: build a cart from the trusted catalog, evaluate it against the active
// permission version, and record a signed, immutable result. The agent (or buyer) only
// names a SKU and quantity — every price, fee, seller and attribute comes from the database.
import { randomUUID } from "node:crypto";
import { canonicalJson } from "../../lib/crypto/canonical.ts";
import {
  CART_SCHEMA_ID,
  evaluateCart,
  priceCart,
  type Cart,
  type Evaluation,
  type ProductAttributes,
  type RuleResult,
  type Verdict,
} from "../../lib/policy/engine.ts";
import type { ApprovedTerms } from "../../lib/permissions/terms.ts";
import { appendEvidence } from "../audit.ts";
import { canonicalHash } from "../crypto/hash.ts";
import { getSigningKey, signRecord, verifyRecord, SIGNING_DOMAINS, type SigningKey } from "../crypto/signing.ts";
import type { Db, Queryable } from "../db/client.ts";
import { hasPasskey, verifyApproval, type PasskeyApprovalInput, type PasskeyProof } from "../auth/webauthn.ts";
import { assertVersionUsable, ServiceError, type PermissionRow } from "./permissions.ts";

/** The buyer's approval of one exact cart, stored with the attempt and embedded in the Purchase Passport. */
export interface CartApproval {
  type: "cart_approval";
  cart_attempt_id: string;
  cart_hash: string;
  approved_at: string;
  assurance: "PASSKEY_VERIFIED" | "APPLICATION_SIGNED";
  passkey?: PasskeyProof;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProductRow {
  sku: string;
  merchant_id: string;
  merchant_name: string;
  merchant_verified: boolean;
  title: string;
  category: string;
  attributes: ProductAttributes;
  price: string;
  shipping: string;
  tax_rate_bps: number;
  currency: string;
  stock: number;
  untrusted_description: string;
}

const PRODUCT_SQL = `
  SELECT p.sku, p.merchant_id, m.display_name AS merchant_name, m.verified AS merchant_verified, p.title, p.category,
         p.attributes, p.price::text AS price, p.shipping::text AS shipping, p.tax_rate_bps, p.currency, p.stock,
         p.untrusted_description
    FROM catalog_products p JOIN merchants m ON m.id = p.merchant_id`;

export async function listCatalog(q: Queryable): Promise<ProductRow[]> {
  return q.query<ProductRow>(`${PRODUCT_SQL} ORDER BY p.merchant_id, p.price`);
}

async function getProduct(q: Queryable, sku: string): Promise<ProductRow> {
  const [row] = await q.query<ProductRow>(`${PRODUCT_SQL} WHERE p.sku = $1`, [sku]);
  if (!row) throw new ServiceError("UNKNOWN_SKU", 404, "That product is not in the catalog.");
  return row;
}

/** The only way a cart is constructed: trusted catalog values, server-side arithmetic. */
export function buildCart(terms: Pick<ApprovedTerms, "policy_id" | "version">, product: ProductRow, quantity: number): Cart {
  return {
    schema: CART_SCHEMA_ID,
    policy_id: terms.policy_id,
    permission_version: terms.version,
    merchant: { id: product.merchant_id, display_name: product.merchant_name },
    currency: product.currency,
    lines: [
      {
        sku: product.sku,
        title: product.title,
        category: product.category,
        quantity,
        unit_price: product.price,
        attributes: product.attributes,
      },
    ],
    ...priceCart({ unitPrice: product.price, quantity, shipping: product.shipping, taxRateBps: product.tax_rate_bps }),
  };
}

async function allowedMerchantNames(q: Queryable, ids: readonly string[]) {
  const rows = await q.query<{ id: string; display_name: string }>("SELECT id, display_name FROM merchants WHERE id = ANY($1::text[])", [ids]);
  return Object.fromEntries(rows.map((r) => [r.id, r.display_name]));
}

async function usability(q: Queryable, versionId: string, now: Date): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await assertVersionUsable(q, versionId, now);
    return { ok: true };
  } catch (e) {
    if (e instanceof ServiceError) return { ok: false, reason: e.message };
    throw e;
  }
}

/** Evaluates without recording — used for previews on the shopping screen. */
export async function previewEvaluations(q: Queryable, versionId: string, terms: ApprovedTerms, products: ProductRow[], now = new Date()) {
  const ctx = {
    now,
    permissionUsable: await usability(q, versionId, now),
    stock: Object.fromEntries(products.map((p) => [p.sku, p.stock])),
    allowedMerchantNames: await allowedMerchantNames(q, terms.merchant_ids),
  };
  const out: Record<string, Evaluation & { total: string }> = {};
  for (const p of products) {
    const cart = buildCart(terms, p, terms.quantity);
    out[p.sku] = { ...evaluateCart(terms, cart, ctx), total: cart.total };
  }
  return out;
}

export interface ActiveVersion {
  permission: PermissionRow;
  versionId: string;
  termsHash: string;
  terms: ApprovedTerms;
}

export async function loadActiveVersion(q: Queryable, userId: string, permissionId: string): Promise<ActiveVersion> {
  if (!UUID_RE.test(permissionId)) throw new ServiceError("NOT_FOUND", 404, "Permission not found.");
  const [row] = await q.query<PermissionRow & { version_id: string; canonical_json: string; terms_hash: string }>(
    `SELECT p.*, v.id AS version_id, v.canonical_json, v.terms_hash
       FROM permissions p JOIN permission_versions v ON v.permission_id = p.id AND v.version = p.active_version
      WHERE p.id = $1`,
    [permissionId],
  );
  if (!row || row.user_id !== userId) throw new ServiceError("NOT_FOUND", 404, "No approved permission found.");
  return { permission: row, versionId: row.version_id, termsHash: row.terms_hash, terms: JSON.parse(row.canonical_json) as ApprovedTerms };
}

export interface EvaluateInput {
  userId: string;
  permissionId: string;
  sku: string;
  quantity?: number;
  source?: "AGENT" | "BUYER_PICK";
  now?: Date;
  signingKey?: SigningKey;
}

/** POST /api/carts/evaluate — builds, evaluates, signs and records one cart attempt. */
export async function evaluateAndRecord(db: Db, input: EvaluateInput) {
  const now = input.now ?? new Date();
  const key = input.signingKey ?? getSigningKey();
  return db.tx(async (q) => {
    const active = await loadActiveVersion(q, input.userId, input.permissionId);
    const quantity = input.quantity ?? active.terms.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new ServiceError("BAD_REQUEST", 400, "Invalid quantity.");
    const product = await getProduct(q, input.sku);
    const cart = buildCart(active.terms, product, quantity);
    const evaluation = evaluateCart(active.terms, cart, {
      now,
      permissionUsable: await usability(q, active.versionId, now),
      stock: { [product.sku]: product.stock },
      allowedMerchantNames: await allowedMerchantNames(q, active.terms.merchant_ids),
    });

    const id = randomUUID();
    const cartHash = canonicalHash(cart);
    const record = {
      type: "cart_evaluation",
      attempt_id: id,
      policy_id: active.terms.policy_id,
      permission_version: active.terms.version,
      terms_hash: active.termsHash,
      cart_hash: cartHash,
      verdict: evaluation.verdict,
      rules_hash: canonicalHash(evaluation.rules),
      evaluated_at: now.toISOString(),
    };
    const { signature, keyId } = signRecord(SIGNING_DOMAINS.cart, record, key);
    await q.query("INSERT INTO signing_keys (key_id, public_key_pem) VALUES ($1, $2) ON CONFLICT (key_id) DO NOTHING", [keyId, key.publicKeyPem]);
    await q.query(
      `INSERT INTO cart_attempts
         (id, permission_version_id, user_id, source, cart_json, cart_hash, verdict, mismatch_codes, evaluation,
          evaluation_record, signature, signing_key_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [id, active.versionId, input.userId, input.source ?? "AGENT", canonicalJson(cart), cartHash, evaluation.verdict,
        JSON.stringify(evaluation.mismatchCodes), JSON.stringify(evaluation.rules), canonicalJson(record), signature, keyId, now.toISOString()],
    );
    await appendEvidence(q, {
      subjectType: "cart",
      subjectId: id,
      eventType: "CART_EVALUATED",
      actorId: input.userId,
      payload: { policy_id: active.terms.policy_id, version: active.terms.version, cart_hash: cartHash, verdict: evaluation.verdict, mismatch_codes: evaluation.mismatchCodes },
      at: now,
    });
    return { id, verdict: evaluation.verdict, cartHash, mismatchCodes: evaluation.mismatchCodes };
  });
}

export interface AttemptRow {
  id: string;
  permission_version_id: string;
  user_id: string;
  source: string;
  cart_json: string;
  cart_hash: string;
  verdict: Verdict;
  mismatch_codes: string[];
  evaluation: RuleResult[];
  evaluation_record: string;
  signature: string;
  signing_key_id: string;
  buyer_cart_approved_at: Date | null;
  buyer_cart_approval: string | null;
  created_at: Date;
}

async function loadAttempt(q: Queryable, userId: string, attemptId: string, forUpdate = false) {
  if (!UUID_RE.test(attemptId)) throw new ServiceError("NOT_FOUND", 404, "Cart not found.");
  const [row] = await q.query<AttemptRow>(`SELECT * FROM cart_attempts WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [attemptId]);
  if (!row || row.user_id !== userId) throw new ServiceError("NOT_FOUND", 404, "Cart not found.");
  return row;
}

async function versionFor(q: Queryable, versionId: string) {
  const [v] = await q.query<{ permission_id: string; canonical_json: string; terms_hash: string }>(
    "SELECT permission_id, canonical_json, terms_hash FROM permission_versions WHERE id = $1",
    [versionId],
  );
  return { permissionId: v.permission_id, terms: JSON.parse(v.canonical_json) as ApprovedTerms, termsHash: v.terms_hash };
}

/**
 * Rebuilds the attempt's cart from today's catalog. If any price, fee, seller or attribute
 * changed, the hash differs and the earlier evaluation/approval no longer applies.
 */
export async function recheckAttempt(q: Queryable, attempt: Pick<AttemptRow, "cart_json" | "cart_hash" | "permission_version_id">) {
  const stored = JSON.parse(attempt.cart_json) as Cart;
  const { terms } = await versionFor(q, attempt.permission_version_id);
  const product = await getProduct(q, stored.lines[0].sku).catch(() => null);
  if (!product) return { sameCart: false, currentHash: null, inStock: false };
  const currentHash = canonicalHash(buildCart(terms, product, stored.lines[0].quantity));
  return { sameCart: currentHash === attempt.cart_hash, currentHash, inStock: product.stock >= stored.lines[0].quantity };
}

export async function getAttemptDetail(q: Queryable, userId: string, attemptId: string, now = new Date()) {
  const a = await loadAttempt(q, userId, attemptId);
  const { permissionId, terms, termsHash } = await versionFor(q, a.permission_version_id);
  const cart = JSON.parse(a.cart_json) as Cart;
  const [key] = await q.query<{ public_key_pem: string }>("SELECT public_key_pem FROM signing_keys WHERE key_id = $1", [a.signing_key_id]);
  const record = JSON.parse(a.evaluation_record) as { cart_hash: string; terms_hash: string; verdict: string; rules_hash: string };
  const integrity = {
    cartIntact: canonicalHash(cart) === a.cart_hash && record.cart_hash === a.cart_hash,
    evaluationIntact: record.verdict === a.verdict && record.rules_hash === canonicalHash(a.evaluation) && record.terms_hash === termsHash,
    signatureValid: !!key && verifyRecord(SIGNING_DOMAINS.cart, record, a.signature, key.public_key_pem),
  };
  const [product] = await q.query<{ untrusted_description: string }>("SELECT untrusted_description FROM catalog_products WHERE sku = $1", [cart.lines[0].sku]);
  const recheck = await recheckAttempt(q, a);
  return {
    attempt: a,
    permissionId,
    terms,
    cart,
    rules: a.evaluation,
    integrity,
    untrustedDescription: product?.untrusted_description ?? "",
    stillCurrent: recheck.sameCart && recheck.inStock,
    permissionUsable: await usability(q, a.permission_version_id, now),
  };
}

/** The buyer approves this exact cart (by hash). Fails if anything changed since the check. */
export async function approveCart(
  db: Db,
  input: { userId: string; attemptId: string; cartHash: string; passkey?: PasskeyApprovalInput; now?: Date },
) {
  const now = input.now ?? new Date();
  return db.tx(async (q) => {
    const a = await loadAttempt(q, input.userId, input.attemptId, true);
    if (a.verdict !== "ALLOW") throw new ServiceError("NOT_ALLOWED", 409, "Only a cart that matches your permission can be approved.");
    if (input.cartHash !== a.cart_hash) throw new ServiceError("CART_CHANGED", 409, "This is not the cart you were shown. Please check again.");
    if (a.buyer_cart_approved_at) return { approvedAt: new Date(a.buyer_cart_approved_at).toISOString(), alreadyApproved: true };
    await assertVersionUsable(q, a.permission_version_id, now);
    const recheck = await recheckAttempt(q, a);
    if (!recheck.sameCart) {
      throw new ServiceError(
        "CART_CHANGED",
        409,
        "The seller changed the price or details since this cart was checked. Run a new check before approving.",
        { previous: a.cart_hash, current: recheck.currentHash },
      );
    }
    if (!recheck.inStock) throw new ServiceError("OUT_OF_STOCK", 409, "The item is no longer in stock.");
    // The passkey signs a challenge derived from this exact cart hash (see auth/webauthn.ts).
    const binding = { purpose: "CART_APPROVAL", cart_attempt_id: a.id, cart_hash: a.cart_hash } as const;
    const passkey = input.passkey ? await verifyApproval(q, input.userId, binding, input.passkey) : null;
    if (!passkey && (await hasPasskey(q, input.userId))) {
      throw new ServiceError("PASSKEY_REQUIRED", 409, "This account has a passkey. Please approve the cart with your passkey.");
    }
    const approval: CartApproval = {
      type: "cart_approval",
      cart_attempt_id: a.id,
      cart_hash: a.cart_hash,
      approved_at: now.toISOString(),
      assurance: passkey ? "PASSKEY_VERIFIED" : "APPLICATION_SIGNED",
      ...(passkey ? { passkey } : {}),
    };
    await q.query("UPDATE cart_attempts SET buyer_cart_approved_at = $2, buyer_cart_approval = $3 WHERE id = $1", [
      a.id,
      now.toISOString(),
      canonicalJson(approval),
    ]);
    await appendEvidence(q, {
      subjectType: "cart",
      subjectId: a.id,
      eventType: "CART_APPROVED_BY_BUYER",
      actorId: input.userId,
      payload: { cart_hash: a.cart_hash, approved_at: now.toISOString(), assurance: approval.assurance, passkey_credential_id: passkey?.credential_id ?? null },
      at: now,
    });
    return { approvedAt: now.toISOString(), alreadyApproved: false, assurance: approval.assurance };
  });
}

export async function listAttempts(q: Queryable, userId: string, permissionId: string) {
  return q.query<{
    id: string;
    verdict: Verdict;
    created_at: Date;
    buyer_cart_approved_at: Date | null;
    version: number;
    title: string;
    total: string;
    mismatch_codes: string[];
  }>(
    `SELECT a.id, a.verdict, a.created_at, a.buyer_cart_approved_at, v.version, a.mismatch_codes,
            (a.cart_json::jsonb -> 'lines' -> 0 ->> 'title') AS title, (a.cart_json::jsonb ->> 'total') AS total
       FROM cart_attempts a JOIN permission_versions v ON v.id = a.permission_version_id
      WHERE a.user_id = $1 AND v.permission_id = $2
      ORDER BY a.created_at DESC`,
    [userId, permissionId],
  );
}
