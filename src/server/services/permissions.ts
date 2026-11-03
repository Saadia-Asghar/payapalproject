// Purchase Permission lifecycle: draft → review → approve (immutable version) → revoke.
// Every function takes the database explicitly so tests can use an in-memory instance.
import { canonicalJson } from "../../lib/crypto/canonical.ts";
import { summarizeTerms } from "../../lib/permissions/summary.ts";
import {
  buildApprovedTerms,
  CONSENT_KEYS,
  CONSENT_STATEMENTS,
  validateTerms,
  type ApprovedTerms,
  type ConsentKey,
  type FieldErrors,
  type TermsFormValues,
} from "../../lib/permissions/terms.ts";
import { appendEvidence } from "../audit.ts";
import { canonicalHash, sha256Hex } from "../crypto/hash.ts";
import { getSigningKey, signRecord, verifyRecord, SIGNING_DOMAINS, type SigningKey } from "../crypto/signing.ts";
import type { Db, Queryable } from "../db/client.ts";

export class ServiceError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, status: number, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type PermissionStatus = "DRAFT" | "ACTIVE" | "REVOKED" | "CONSUMED";
export type EffectiveStatus = PermissionStatus | "EXPIRED";

export interface PermissionRow {
  id: string;
  public_id: string;
  user_id: string;
  status: PermissionStatus;
  draft_json: Record<string, unknown> | null;
  reviewed_terms_hash: string | null;
  active_version: number | null;
  used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface VersionRow {
  id: string;
  permission_id: string;
  version: number;
  canonical_json: string;
  terms_hash: string;
  summary_text: string;
  expires_at: Date;
  approved_by: string;
  approved_at: Date;
  approval_evidence: Record<string, unknown>;
  approval_record: string;
  signature: string;
  signing_key_id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DRAFT_BYTES = 16_384;

export async function listMerchants(q: Queryable) {
  return q.query<{ id: string; display_name: string }>("SELECT id, display_name FROM merchants WHERE verified ORDER BY display_name");
}

async function merchantNameMap(q: Queryable, ids: string[]): Promise<Record<string, string>> {
  const rows = await q.query<{ id: string; display_name: string }>(
    "SELECT id, display_name FROM merchants WHERE verified AND id = ANY($1::text[])",
    [ids],
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.display_name]));
}

async function loadOwned(q: Queryable, userId: string, permissionId: string, forUpdate = false): Promise<PermissionRow> {
  if (!UUID_RE.test(permissionId)) throw new ServiceError("NOT_FOUND", 404, "Permission not found.");
  const [row] = await q.query<PermissionRow>(
    `SELECT * FROM permissions WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [permissionId],
  );
  // Same response for "missing" and "someone else's" so ids can't be probed.
  if (!row || row.user_id !== userId) throw new ServiceError("NOT_FOUND", 404, "Permission not found.");
  return row;
}

export function effectiveStatus(
  p: Pick<PermissionRow, "status">,
  active: Pick<VersionRow, "expires_at"> | undefined,
  now = new Date(),
): EffectiveStatus {
  if (p.status === "ACTIVE" && active && new Date(active.expires_at).getTime() <= now.getTime()) return "EXPIRED";
  return p.status;
}

/** Converts an approved version back into editable form values (to start version n+1). */
export function formValuesFromApproved(t: ApprovedTerms): TermsFormValues {
  return {
    request_text: t.request_text,
    product_type: t.product.type,
    color: t.product.color,
    size: t.product.size,
    brand: t.product.brand,
    condition: t.product.condition,
    quantity: t.quantity,
    max_total: t.max_total.value,
    currency: "USD",
    merchant_ids: [...t.merchant_ids],
    delivery_ref: t.delivery_ref,
    expires_at: t.expires_at,
    display_timezone: t.display_timezone,
    substitutions: t.substitutions,
    recurring: false,
    review_mode: "APPROVE_FINAL_CART",
    single_use: true,
    notes: t.notes,
  };
}

const SUGGESTABLE = new Set(["product_type", "color", "size", "brand", "condition", "quantity", "max_total", "merchant_ids", "expires_at", "substitutions", "notes"]);

export function aiSuggestedFields(draft: Record<string, unknown> | null): string[] {
  const raw = draft?.ai_suggested_fields;
  return Array.isArray(raw) ? [...new Set(raw.filter((f): f is string => typeof f === "string" && SUGGESTABLE.has(f)))].sort() : [];
}

function sanitizeDraft(draft: unknown): Record<string, unknown> {
  if (typeof draft !== "object" || draft === null || Array.isArray(draft)) {
    throw new ServiceError("BAD_REQUEST", 400, "Draft must be an object.");
  }
  if (JSON.stringify(draft).length > MAX_DRAFT_BYTES) throw new ServiceError("TOO_LARGE", 413, "Draft too large.");
  return draft as Record<string, unknown>;
}

export async function createPermission(db: Db, userId: string, draft?: unknown) {
  const [row] = await db.query<{ id: string; public_id: string }>(
    "INSERT INTO permissions (user_id, draft_json) VALUES ($1, $2) RETURNING id, public_id",
    [userId, draft === undefined ? null : JSON.stringify(sanitizeDraft(draft))],
  );
  return row;
}

/** Saves the editable working copy. Any edit invalidates a previous review. */
export async function saveDraft(db: Db, userId: string, permissionId: string, draft: unknown, now = new Date()) {
  const clean = sanitizeDraft(draft);
  return db.tx(async (q) => {
    const p = await loadOwned(q, userId, permissionId, true);
    if (p.status === "REVOKED" || p.status === "CONSUMED") {
      throw new ServiceError("NOT_EDITABLE", 409, `This permission is ${p.status.toLowerCase()} and can’t be edited.`);
    }
    await q.query(
      "UPDATE permissions SET draft_json = $2, reviewed_terms_hash = NULL, updated_at = now() WHERE id = $1",
      [p.id, JSON.stringify(clean)],
    );
    const result = validateTerms(clean, now);
    return { saved: true, errors: result.ok ? {} : result.errors };
  });
}

export interface ReviewResult {
  policyId: string;
  version: number;
  terms: ApprovedTerms;
  canonical: string;
  termsHash: string;
  summary: string;
  merchants: Record<string, string>;
}

async function prepareVersion(q: Queryable, p: PermissionRow, now: Date): Promise<ReviewResult | { errors: FieldErrors }> {
  if (!p.draft_json) return { errors: { _form: "Nothing to review — fill out the permission form first." } };
  const v = validateTerms(p.draft_json, now);
  if (!v.ok) return { errors: v.errors };
  const merchants = await merchantNameMap(q, v.terms.merchant_ids);
  const unknown = v.terms.merchant_ids.filter((id) => !merchants[id]);
  if (unknown.length) return { errors: { merchant_ids: `Unknown seller id: ${unknown.join(", ")}` } };
  const version = (p.active_version ?? 0) + 1;
  const approved = buildApprovedTerms(v.terms, p.public_id, version);
  return {
    policyId: p.public_id,
    version,
    terms: approved,
    canonical: canonicalJson(approved),
    termsHash: canonicalHash(approved),
    summary: summarizeTerms(v.terms, merchants),
    merchants,
  };
}

/** Screen 2: validate, canonicalize and remember exactly what the buyer is being shown. */
export async function reviewPermission(db: Db, userId: string, permissionId: string, now = new Date()) {
  return db.tx(async (q) => {
    const p = await loadOwned(q, userId, permissionId, true);
    if (p.status === "REVOKED" || p.status === "CONSUMED") {
      throw new ServiceError("NOT_EDITABLE", 409, `This permission is ${p.status.toLowerCase()}.`);
    }
    const prepared = await prepareVersion(q, p, now);
    if ("errors" in prepared) throw new ServiceError("INVALID_TERMS", 422, "The permission form has problems.", prepared.errors);
    await q.query("UPDATE permissions SET reviewed_terms_hash = $2, updated_at = now() WHERE id = $1", [p.id, prepared.termsHash]);
    return prepared;
  });
}

export interface ApproveInput {
  userId: string;
  sessionId: string;
  permissionId: string;
  termsHash: string;
  consents: Partial<Record<ConsentKey, boolean>>;
  userAgent?: string | null;
  now?: Date;
  signingKey?: SigningKey;
}

/**
 * Screen 2 → 3: records an immutable, signed permission version.
 * Accepted only when the hash the buyer approved equals both the hash computed at review
 * time and the hash recomputed now from the stored draft.
 */
export async function approvePermission(db: Db, input: ApproveInput) {
  const now = input.now ?? new Date();
  const missing = CONSENT_KEYS.filter((k) => input.consents[k] !== true);
  if (missing.length) {
    throw new ServiceError("CONSENT_REQUIRED", 422, "Please confirm all three statements before approving.", { missing });
  }
  const key = input.signingKey ?? getSigningKey();

  return db.tx(async (q) => {
    const p = await loadOwned(q, input.userId, input.permissionId, true);
    if (p.status === "REVOKED" || p.status === "CONSUMED") {
      throw new ServiceError("NOT_EDITABLE", 409, `This permission is ${p.status.toLowerCase()}.`);
    }
    const prepared = await prepareVersion(q, p, now);
    if ("errors" in prepared) throw new ServiceError("INVALID_TERMS", 422, "The permission form has problems.", prepared.errors);
    if (!p.reviewed_terms_hash || p.reviewed_terms_hash !== prepared.termsHash || input.termsHash !== prepared.termsHash) {
      throw new ServiceError("TERMS_CHANGED", 409, "The terms changed after you reviewed them. Please review the latest version again.");
    }

    const approvedAt = now.toISOString();
    const evidence = {
      auth_method: "PASSWORD_SESSION",
      session_ref: sha256Hex(input.sessionId).slice(0, 16),
      user_agent_sha256: input.userAgent ? sha256Hex(input.userAgent) : null,
      consents: CONSENT_KEYS.map((k) => ({ key: k, text: CONSENT_STATEMENTS[k], accepted: true })),
      summary_sha256: sha256Hex(prepared.summary),
      // Fields the AI pre-filled that the buyer then reviewed and kept (never silent consent).
      ai_suggested_fields: aiSuggestedFields(p.draft_json),
    };
    const record = {
      type: "permission_approval",
      policy_id: prepared.policyId,
      version: prepared.version,
      terms_hash: prepared.termsHash,
      approved_by: input.userId,
      approved_at: approvedAt,
      evidence,
      assurance: "APPLICATION_SIGNED",
    };
    const { signature, keyId } = signRecord(SIGNING_DOMAINS.permissionApproval, record, key);
    await q.query("INSERT INTO signing_keys (key_id, public_key_pem) VALUES ($1, $2) ON CONFLICT (key_id) DO NOTHING", [
      keyId,
      key.publicKeyPem,
    ]);

    const [version] = await q.query<VersionRow>(
      `INSERT INTO permission_versions
         (permission_id, version, canonical_json, terms_hash, summary_text, expires_at, approved_by, approved_at,
          approval_evidence, approval_record, signature, signing_key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [p.id, prepared.version, prepared.canonical, prepared.termsHash, prepared.summary, prepared.terms.expires_at,
        input.userId, approvedAt, JSON.stringify(evidence), canonicalJson(record), signature, keyId],
    );
    await q.query(
      `UPDATE permissions SET status = 'ACTIVE', active_version = $2, draft_json = NULL,
         reviewed_terms_hash = NULL, updated_at = now() WHERE id = $1`,
      [p.id, prepared.version],
    );
    await appendEvidence(q, {
      subjectType: "permission",
      subjectId: prepared.policyId,
      eventType: "PERMISSION_APPROVED",
      actorId: input.userId,
      payload: { version: prepared.version, terms_hash: prepared.termsHash, signature_key_id: keyId, approved_at: approvedAt },
      at: now,
    });
    return { policyId: prepared.policyId, version: version.version, termsHash: version.terms_hash, approvedAt };
  });
}

/** Stops future use. Does not reverse any captured payment (refunds are a separate merchant step). */
export async function revokePermission(db: Db, userId: string, permissionId: string, now = new Date()) {
  return db.tx(async (q) => {
    const p = await loadOwned(q, userId, permissionId, true);
    if (p.status !== "ACTIVE") throw new ServiceError("NOT_ACTIVE", 409, "Only an active permission can be revoked.");
    await q.query(
      `UPDATE permissions SET status = 'REVOKED', revoked_at = $2, draft_json = NULL,
         reviewed_terms_hash = NULL, updated_at = now() WHERE id = $1`,
      [p.id, now.toISOString()],
    );
    await appendEvidence(q, {
      subjectType: "permission",
      subjectId: p.public_id,
      eventType: "PERMISSION_REVOKED",
      actorId: userId,
      payload: { active_version: p.active_version, revoked_at: now.toISOString() },
      at: now,
    });
    return { policyId: p.public_id, revokedAt: now.toISOString() };
  });
}

/** Discards unapproved edits. A never-approved permission is deleted; approved ones are only ever revoked. */
export async function discardDraft(db: Db, userId: string, permissionId: string) {
  return db.tx(async (q) => {
    const p = await loadOwned(q, userId, permissionId, true);
    if (p.active_version) {
      await q.query("UPDATE permissions SET draft_json = NULL, reviewed_terms_hash = NULL, updated_at = now() WHERE id = $1", [p.id]);
      return { deleted: false };
    }
    await q.query("DELETE FROM permissions WHERE id = $1", [p.id]);
    return { deleted: true };
  });
}

/**
 * Server-side gate for later phases (cart evaluation, order creation, capture):
 * the permission version must be the active one, unexpired, unrevoked and unused.
 */
export async function assertVersionUsable(q: Queryable, permissionVersionId: string, now = new Date()) {
  if (!UUID_RE.test(permissionVersionId)) throw new ServiceError("NOT_FOUND", 404, "Permission version not found.");
  const [row] = await q.query<PermissionRow & { v_version: number; v_expires_at: Date }>(
    `SELECT p.*, v.version AS v_version, v.expires_at AS v_expires_at
       FROM permission_versions v JOIN permissions p ON p.id = v.permission_id
      WHERE v.id = $1`,
    [permissionVersionId],
  );
  if (!row) throw new ServiceError("NOT_FOUND", 404, "Permission version not found.");
  if (row.status === "REVOKED") throw new ServiceError("REVOKED", 409, "This permission was revoked.");
  if (row.status === "CONSUMED" || row.used_at) throw new ServiceError("CONSUMED", 409, "This single-use permission was already used.");
  if (row.status !== "ACTIVE") throw new ServiceError("NOT_ACTIVE", 409, "This permission is not active.");
  if (row.active_version !== row.v_version) throw new ServiceError("SUPERSEDED", 409, "A newer version of this permission was approved.");
  if (new Date(row.v_expires_at).getTime() <= now.getTime()) throw new ServiceError("EXPIRED", 409, "This permission has expired.");
  return row;
}

export async function listPermissions(q: Queryable, userId: string, now = new Date()) {
  const rows = await q.query<PermissionRow & { expires_at: Date | null; max_total: string | null; summary_text: string | null }>(
    `SELECT p.*, v.expires_at, v.summary_text, (v.canonical_json::jsonb -> 'max_total' ->> 'value') AS max_total
       FROM permissions p
       LEFT JOIN permission_versions v ON v.permission_id = p.id AND v.version = p.active_version
      WHERE p.user_id = $1
      ORDER BY p.created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    ...r,
    effective_status: effectiveStatus(r, r.expires_at ? { expires_at: r.expires_at } : undefined, now),
  }));
}

export async function getPermissionDetail(q: Queryable, userId: string, permissionId: string, now = new Date()) {
  const p = await loadOwned(q, userId, permissionId);
  const versions = await q.query<VersionRow & { public_key_pem: string | null }>(
    `SELECT v.*, k.public_key_pem FROM permission_versions v
       LEFT JOIN signing_keys k ON k.key_id = v.signing_key_id
      WHERE v.permission_id = $1 ORDER BY v.version DESC`,
    [p.id],
  );
  const checked = versions.map((v) => {
    const record = JSON.parse(v.approval_record) as { terms_hash: string };
    const termsIntact = canonicalHash(JSON.parse(v.canonical_json)) === v.terms_hash && record.terms_hash === v.terms_hash;
    const signatureValid = !!v.public_key_pem && verifyRecord(SIGNING_DOMAINS.permissionApproval, record, v.signature, v.public_key_pem);
    return { ...v, terms: JSON.parse(v.canonical_json) as ApprovedTerms, integrity: { termsIntact, signatureValid } };
  });
  const active = checked.find((v) => v.version === p.active_version);
  return { permission: p, effectiveStatus: effectiveStatus(p, active, now), active, versions: checked };
}
