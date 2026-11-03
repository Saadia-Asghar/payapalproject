// Merchant workspace + dispute evidence packets.
// Packets state only facts found in stored records, list what is missing, and never claim
// legal liability or chargeback outcomes. SAMPLE cases are labelled as such everywhere;
// nothing here is submitted to PayPal.
import { canonicalJson } from "../../lib/crypto/canonical.ts";
import type { Cart, RuleResult, Verdict } from "../../lib/policy/engine.ts";
import type { ApprovedTerms } from "../../lib/permissions/terms.ts";
import { appendEvidence } from "../audit.ts";
import { canonicalHash, sha256Hex } from "../crypto/hash.ts";
import { verifyPasskeyProof } from "../auth/webauthn.ts";
import { verifyRecord, SIGNING_DOMAINS } from "../crypto/signing.ts";
import type { Db, Queryable } from "../db/client.ts";
import { ServiceError } from "./permissions.ts";

export const DISPUTE_REASONS = {
  NOT_AUTHORIZED: "I did not approve this purchase",
  WRONG_ITEM: "The item was wrong",
  NOT_RECEIVED: "The item never arrived",
  EXCEEDED_INSTRUCTIONS: "The agent exceeded instructions",
} as const;
export type DisputeReason = keyof typeof DISPUTE_REASONS;

export type EvidenceStatus = "PROVIDED" | "MISSING" | "NOT_APPLICABLE";
export interface EvidenceItem {
  label: string;
  status: EvidenceStatus;
  detail: string;
}

export interface EvidencePacket {
  schema: "cartwitness.evidence-packet.v1";
  case_id: string;
  source: "SAMPLE" | "REAL";
  notice: string;
  reason: DisputeReason;
  reason_label: string;
  complaint: string;
  generated_at: string;
  merchant: { id: string; display_name: string };
  subject: {
    buyer_ref: string;
    policy_id: string;
    permission_version: number;
    terms_hash: string;
    cart_attempt_id: string;
    cart_hash: string;
    verdict: Verdict;
    reconciliation_key: string | null;
    paypal_order_id: string | null;
    paypal_capture_id: string | null;
    amount: string;
    currency: string;
    passport_id: string | null;
  };
  checklist: EvidenceItem[];
  timeline: { at: string; event: string; detail: string }[];
  findings: string[];
  narrative: string[];
  limitations: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownedMerchantIds(q: Queryable, userId: string) {
  const rows = await q.query<{ id: string }>("SELECT id FROM merchants WHERE owner_user_id = $1", [userId]);
  return rows.map((r) => r.id);
}

/** Cart attempts against the merchant's stores, with payment / passport / dispute status. */
export async function listMerchantActivity(q: Queryable, userId: string) {
  const ids = await ownedMerchantIds(q, userId);
  if (!ids.length) return [];
  return q.query<{
    id: string;
    created_at: Date;
    verdict: Verdict;
    title: string;
    total: string;
    merchant_id: string;
    buyer_cart_approved_at: Date | null;
    policy_id: string;
    version: number;
    payment_status: string | null;
    passport_id: string | null;
    dispute_id: string | null;
    mismatch_codes: string[];
  }>(
    `SELECT a.id, a.created_at, a.verdict, a.buyer_cart_approved_at, a.mismatch_codes,
            a.cart_json::jsonb -> 'lines' -> 0 ->> 'title' AS title, a.cart_json::jsonb ->> 'total' AS total,
            a.cart_json::jsonb -> 'merchant' ->> 'id' AS merchant_id, p.public_id AS policy_id, v.version,
            o.status AS payment_status, pp.id AS passport_id,
            (SELECT d.id FROM dispute_cases d WHERE d.cart_attempt_id = a.id ORDER BY d.created_at DESC LIMIT 1) AS dispute_id
       FROM cart_attempts a
       JOIN permission_versions v ON v.id = a.permission_version_id
       JOIN permissions p ON p.id = v.permission_id
       LEFT JOIN payment_orders o ON o.cart_attempt_id = a.id
       LEFT JOIN passports pp ON pp.payment_order_id = o.id
      WHERE a.cart_json::jsonb -> 'merchant' ->> 'id' = ANY($1::text[])
      ORDER BY a.created_at DESC
      LIMIT 200`,
    [ids],
  );
}

interface Facts {
  attempt: {
    id: string;
    user_id: string;
    cart_json: string;
    cart_hash: string;
    verdict: Verdict;
    evaluation: RuleResult[];
    evaluation_record: string;
    signature: string;
    signing_key_id: string;
    buyer_cart_approved_at: Date | null;
    buyer_cart_approval: string | null;
    created_at: Date;
  };
  version: { canonical_json: string; terms_hash: string; approval_record: string; signature: string; signing_key_id: string; approved_at: Date };
  policyId: string;
  payment: { id: string; reconciliation_key: string; paypal_order_id: string | null; status: string; capture_id: string | null; captured_at: Date | null } | null;
  passportId: string | null;
  keys: Record<string, string>;
  /** Result of re-verifying the buyer's passkey signatures; null when that approval used no passkey. */
  passkey: { terms: boolean | null; cart: boolean | null };
}

async function gatherFacts(q: Queryable, attemptId: string): Promise<Facts> {
  const [attempt] = await q.query<Facts["attempt"] & { permission_version_id: string }>("SELECT * FROM cart_attempts WHERE id = $1", [attemptId]);
  if (!attempt) throw new ServiceError("NOT_FOUND", 404, "Cart not found.");
  const [version] = await q.query<Facts["version"] & { permission_id: string; version: number }>("SELECT * FROM permission_versions WHERE id = $1", [attempt.permission_version_id]);
  const [perm] = await q.query<{ public_id: string }>("SELECT public_id FROM permissions WHERE id = $1", [version.permission_id]);
  const [payment] = await q.query<NonNullable<Facts["payment"]>>(
    `SELECT o.id, o.reconciliation_key, o.paypal_order_id, o.status, c.paypal_capture_id AS capture_id, c.created_at AS captured_at
       FROM payment_orders o LEFT JOIN payment_captures c ON c.payment_order_id = o.id WHERE o.cart_attempt_id = $1`,
    [attemptId],
  );
  const [pp] = payment ? await q.query<{ id: string }>("SELECT id FROM passports WHERE payment_order_id = $1", [payment.id]) : [];
  const keyRows = await q.query<{ key_id: string; public_key_pem: string }>("SELECT key_id, public_key_pem FROM signing_keys");
  const approvalProof = (JSON.parse(version.approval_record) as { passkey?: unknown }).passkey;
  const cartProof = attempt.buyer_cart_approval ? (JSON.parse(attempt.buyer_cart_approval) as { passkey?: unknown }).passkey : undefined;
  return {
    passkey: {
      terms: approvalProof
        ? await verifyPasskeyProof(approvalProof, { purpose: "PERMISSION_APPROVAL", policy_id: perm.public_id, version: version.version, terms_hash: version.terms_hash })
        : null,
      cart: cartProof ? await verifyPasskeyProof(cartProof, { purpose: "CART_APPROVAL", cart_attempt_id: attempt.id, cart_hash: attempt.cart_hash }) : null,
    },
    attempt,
    version,
    policyId: perm.public_id,
    payment: payment ?? null,
    passportId: pp?.id ?? null,
    keys: Object.fromEntries(keyRows.map((k) => [k.key_id, k.public_key_pem])),
  };
}

const iso = (d: Date | string) => new Date(d).toISOString();

/** Deterministic packet builder: every statement is derived from a stored record. */
export function buildPacket(input: {
  caseId: string;
  source: "SAMPLE" | "REAL";
  reason: DisputeReason;
  complaint: string;
  now: Date;
  facts: Facts;
  events: { created_at: Date; event_type: string; subject_type: string }[];
}): EvidencePacket {
  const { facts: f, reason } = input;
  const terms = JSON.parse(f.version.canonical_json) as ApprovedTerms;
  const cart = JSON.parse(f.attempt.cart_json) as Cart;
  const approvalRecord = JSON.parse(f.version.approval_record);
  const evalRecord = JSON.parse(f.attempt.evaluation_record);
  const termsIntact = canonicalHash(terms) === f.version.terms_hash;
  const approvalValid = !!f.keys[f.version.signing_key_id] && verifyRecord(SIGNING_DOMAINS.permissionApproval, approvalRecord, f.version.signature, f.keys[f.version.signing_key_id]);
  const cartIntact = canonicalHash(cart) === f.attempt.cart_hash && evalRecord.cart_hash === f.attempt.cart_hash;
  const evalValid = !!f.keys[f.attempt.signing_key_id] && verifyRecord(SIGNING_DOMAINS.cart, evalRecord, f.attempt.signature, f.keys[f.attempt.signing_key_id]);
  const captured = f.payment?.status === "CAPTURED" && !!f.payment.capture_id;
  const line = cart.lines[0];
  const failing = f.attempt.evaluation.filter((r) => r.status !== "PASS");

  const item = (label: string, ok: boolean, provided: string, missing: string): EvidenceItem => ({
    label,
    status: ok ? "PROVIDED" : "MISSING",
    detail: ok ? provided : missing,
  });
  const terms_ = item("Approved permission terms (versioned snapshot)", termsIntact, `${f.policyId} v${terms.version}, fingerprint ${f.version.terms_hash.slice(0, 23)}…`, "Stored terms do not match their fingerprint.");
  const approval = item(
    "Buyer approval event",
    approvalValid && f.passkey.terms !== false,
    f.passkey.terms
      ? `Approved ${iso(f.version.approved_at)} with the buyer's passkey (WebAuthn, user-verified) over these exact terms; passkey and application signatures valid.`
      : `Approved ${iso(f.version.approved_at)} by an authenticated session; application signature valid. No passkey was used, so this does not cryptographically bind the approval to the buyer's device.`,
    f.passkey.terms === false ? "The buyer's passkey signature over the terms failed verification." : "Approval signature could not be verified.",
  );
  const cartProof = item("Evaluated cart snapshot and verdict", cartIntact && evalValid, `Cart ${f.attempt.cart_hash.slice(0, 23)}…, verdict ${f.attempt.verdict}, signature valid.`, "Cart record or its signature failed verification.");
  const cartApproval = item(
    "Buyer approval of this exact cart",
    !!f.attempt.buyer_cart_approved_at && f.passkey.cart !== false,
    `Approved ${f.attempt.buyer_cart_approved_at ? iso(f.attempt.buyer_cart_approved_at) : ""}${f.passkey.cart ? " with the buyer's passkey over this exact cart fingerprint (signature valid)" : " in an authenticated session (no passkey)"}.`,
    f.passkey.cart === false ? "The buyer's passkey signature over the cart failed verification." : "The buyer did not approve this cart in CartWitness.",
  );
  const paypal = item(
    "PayPal order and capture identifiers",
    captured,
    `Order ${f.payment?.paypal_order_id}, capture ${f.payment?.capture_id}, reconciliation key ${f.payment?.reconciliation_key}.`,
    f.payment ? `Payment order ${f.payment.reconciliation_key} is ${f.payment.status}; no completed capture.` : "No PayPal payment is recorded for this cart.",
  );
  const missing = (label: string, detail: string): EvidenceItem => ({ label, status: "MISSING", detail });

  const checklists: Record<DisputeReason, EvidenceItem[]> = {
    NOT_AUTHORIZED: [terms_, approval, cartProof, cartApproval, paypal],
    WRONG_ITEM: [
      terms_,
      cartProof,
      { label: "Approved product vs checked-out item", status: "PROVIDED", detail: `Allowed ${terms.product.type}${terms.product.size ? `, size ${terms.product.size}` : ""}${terms.product.color ? `, ${terms.product.color}` : ""}; cart contained ${line.sku} (${line.attributes.size ?? "no size"}, ${line.attributes.color ?? "no colour"}).` },
      paypal,
      missing("Merchant fulfilment record (SKU and variant shipped)", "Merchant must upload proof of the exact item shipped. CartWitness has no fulfilment data."),
    ],
    NOT_RECEIVED: [
      paypal,
      { label: "Delivery reference", status: terms.delivery_ref ? "PROVIDED" : "MISSING", detail: terms.delivery_ref ? `Buyer specified ${terms.delivery_ref} (address not stored in CartWitness).` : "No delivery reference in the permission." },
      missing("Shipment tracking number", "Not recorded. Merchant must supply carrier tracking."),
      missing("Carrier proof of delivery", "Not recorded. Merchant must supply delivery confirmation."),
    ],
    EXCEEDED_INSTRUCTIONS: [
      terms_,
      approval,
      cartProof,
      { label: "Rule-by-rule comparison of cart vs permission", status: "PROVIDED", detail: failing.length ? `${failing.length} rule(s) not passed: ${failing.map((r) => r.code).join(", ")}.` : "All rules passed." },
      { label: "Seller identity (verified ID)", status: "PROVIDED", detail: `${cart.merchant.display_name} (${cart.merchant.id}); allowed: ${terms.merchant_ids.join(", ")}.` },
      paypal,
    ],
  };
  const checklist = checklists[reason];

  const findings: string[] = [];
  findings.push(
    f.attempt.verdict === "ALLOW"
      ? `The cart was checked against ${f.policyId} v${terms.version} and every rule passed.`
      : `The cart was checked against ${f.policyId} v${terms.version} and received ${f.attempt.verdict}: ${failing.map((r) => `${r.label} — ${r.message}`).join(" ")}`,
  );
  if (f.attempt.buyer_cart_approved_at) findings.push(`The buyer approved this exact cart (fingerprint ${f.attempt.cart_hash.slice(0, 23)}…) in CartWitness.`);
  if (!captured) findings.push("No completed PayPal capture is linked to this cart, so payment facts cannot be confirmed.");
  if (reason === "EXCEEDED_INSTRUCTIONS") {
    findings.push(
      failing.some((r) => r.status === "FAIL")
        ? "Mismatch confirmed by the stored evaluation. Recommended: merchant-reviewed resolution or refund."
        : "No rule violation was found in the stored evaluation.",
    );
  }
  if (reason === "WRONG_ITEM") findings.push("Whether the shipped item matched the cart cannot be determined without the merchant's fulfilment record.");
  if (reason === "NOT_RECEIVED") findings.push("Delivery cannot be confirmed: no tracking or delivery evidence is recorded.");

  const narrative = [
    `${DISPUTE_REASONS[reason]}: case ${input.caseId} concerns ${line.title} (${line.sku}) from ${cart.merchant.display_name}, total ${cart.total} ${cart.currency}.`,
    `The buyer approved permission ${f.policyId} v${terms.version} on ${iso(f.version.approved_at)}, allowing up to ${terms.max_total.value} ${terms.max_total.currency} for ${terms.product.type} from ${terms.merchant_ids.join(", ")} until ${terms.expires_at}.`,
    `On ${iso(f.attempt.created_at)} the cart was evaluated with verdict ${f.attempt.verdict}.`,
    captured
      ? `PayPal sandbox capture ${f.payment!.capture_id} was recorded on ${iso(f.payment!.captured_at!)}${f.passportId ? ` and Purchase Passport ${f.passportId} was issued` : ""}.`
      : "No PayPal capture is recorded for this cart.",
    `${checklist.filter((c) => c.status === "MISSING").length} evidence item(s) are missing and are listed in the checklist.`,
  ];

  return {
    schema: "cartwitness.evidence-packet.v1",
    case_id: input.caseId,
    source: input.source,
    notice:
      input.source === "SAMPLE"
        ? "SAMPLE CASE — created for demonstration. This is not a PayPal dispute and was not submitted to PayPal."
        : "Real PayPal dispute data. Review before any submission; this packet is not submitted automatically.",
    reason,
    reason_label: DISPUTE_REASONS[reason],
    complaint: input.complaint,
    generated_at: input.now.toISOString(),
    merchant: cart.merchant,
    subject: {
      buyer_ref: `buyer-${sha256Hex(f.attempt.user_id).slice(0, 10)}`,
      policy_id: f.policyId,
      permission_version: terms.version,
      terms_hash: f.version.terms_hash,
      cart_attempt_id: f.attempt.id,
      cart_hash: f.attempt.cart_hash,
      verdict: f.attempt.verdict,
      reconciliation_key: f.payment?.reconciliation_key ?? null,
      paypal_order_id: f.payment?.paypal_order_id ?? null,
      paypal_capture_id: f.payment?.capture_id ?? null,
      amount: cart.total,
      currency: cart.currency,
      passport_id: f.passportId,
    },
    checklist,
    timeline: input.events.map((e) => ({ at: iso(e.created_at), event: e.event_type, detail: e.subject_type })),
    findings,
    narrative,
    limitations: [
      "Approval evidence is application-signed: it shows an authenticated CartWitness session approved these terms, not which person clicked, nor that the PayPal payer is the same person.",
      "Records are tamper-evident, not tamper-proof. This packet supports a review; it does not establish legal authorization or guarantee any dispute outcome.",
      "Narrative is generated from stored records only.",
    ],
  };
}

async function eventsFor(q: Queryable, f: Facts) {
  const subjects = [f.policyId, f.attempt.id, f.payment?.id, f.passportId].filter(Boolean) as string[];
  return q.query<{ created_at: Date; event_type: string; subject_type: string }>(
    "SELECT created_at, event_type, subject_type FROM evidence_events WHERE subject_id = ANY($1::text[]) ORDER BY seq",
    [subjects],
  );
}

/** Opens a clearly labelled SAMPLE dispute on one of the merchant's carts and builds its packet. */
export async function openSampleDispute(db: Db, input: { userId: string; attemptId: string; reason: DisputeReason; complaint: string; now?: Date }) {
  const now = input.now ?? new Date();
  if (!(input.reason in DISPUTE_REASONS)) throw new ServiceError("BAD_REQUEST", 400, "Unknown dispute reason.");
  if (!UUID_RE.test(input.attemptId)) throw new ServiceError("NOT_FOUND", 404, "Cart not found.");
  return db.tx(async (q) => {
    const owned = await ownedMerchantIds(q, input.userId);
    const facts = await gatherFacts(q, input.attemptId);
    const cart = JSON.parse(facts.attempt.cart_json) as Cart;
    if (!owned.includes(cart.merchant.id)) throw new ServiceError("NOT_FOUND", 404, "Cart not found.");

    const [c] = await q.query<{ id: string; public_id: string }>(
      `INSERT INTO dispute_cases (payment_order_id, cart_attempt_id, merchant_id, opened_by, source, reason, complaint, created_at)
       VALUES ($1, $2, $3, $4, 'SAMPLE', $5, $6, $7) RETURNING id, public_id`,
      [facts.payment?.id ?? null, facts.attempt.id, cart.merchant.id, input.userId, input.reason, input.complaint.slice(0, 1000), now.toISOString()],
    );
    await appendEvidence(q, {
      subjectType: "dispute",
      subjectId: c.public_id,
      caseId: c.id,
      eventType: "SAMPLE_DISPUTE_OPENED",
      actorId: input.userId,
      payload: { reason: input.reason, cart_attempt_id: facts.attempt.id },
      at: now,
    });
    const packet = buildPacket({ caseId: c.public_id, source: "SAMPLE", reason: input.reason, complaint: input.complaint.slice(0, 1000), now, facts, events: await eventsFor(q, facts) });
    await q.query("UPDATE dispute_cases SET packet_json = $2, packet_hash = $3 WHERE id = $1", [c.id, canonicalJson(packet), canonicalHash(packet)]);
    return { id: c.id, publicId: c.public_id };
  });
}

interface DisputeRow {
  id: string;
  public_id: string;
  merchant_id: string;
  source: "SAMPLE" | "REAL";
  reason: DisputeReason;
  status: "OPEN" | "REVIEWED";
  complaint: string;
  packet_json: string;
  packet_hash: string;
  reviewer_note: string | null;
  reviewed_at: Date | null;
  created_at: Date;
}

export async function getDispute(q: Queryable, userId: string, caseId: string) {
  if (!UUID_RE.test(caseId)) throw new ServiceError("NOT_FOUND", 404, "Case not found.");
  const [d] = await q.query<DisputeRow>("SELECT * FROM dispute_cases WHERE id = $1", [caseId]);
  if (!d || !(await ownedMerchantIds(q, userId)).includes(d.merchant_id)) throw new ServiceError("NOT_FOUND", 404, "Case not found.");
  const packet = JSON.parse(d.packet_json) as EvidencePacket;
  return { dispute: d, packet, packetIntact: canonicalHash(packet) === d.packet_hash };
}

export async function listDisputes(q: Queryable, userId: string) {
  const ids = await ownedMerchantIds(q, userId);
  return q.query<{ id: string; public_id: string; source: string; reason: DisputeReason; status: string; created_at: Date }>(
    "SELECT id, public_id, source, reason, status, created_at FROM dispute_cases WHERE merchant_id = ANY($1::text[]) ORDER BY created_at DESC",
    [ids],
  );
}

/** Human merchant review step. The packet itself is never edited. */
export async function reviewDispute(db: Db, input: { userId: string; caseId: string; note: string; now?: Date }) {
  const now = input.now ?? new Date();
  const note = input.note.trim();
  if (note.length < 3) throw new ServiceError("BAD_REQUEST", 400, "Add a short review note.");
  return db.tx(async (q) => {
    const { dispute } = await getDispute(q, input.userId, input.caseId);
    if (dispute.status === "REVIEWED") throw new ServiceError("ALREADY_REVIEWED", 409, "This case was already reviewed.");
    await q.query("UPDATE dispute_cases SET status = 'REVIEWED', reviewer_id = $2, reviewer_note = $3, reviewed_at = $4 WHERE id = $1", [
      dispute.id,
      input.userId,
      note.slice(0, 2000),
      now.toISOString(),
    ]);
    await appendEvidence(q, {
      subjectType: "dispute",
      subjectId: dispute.public_id,
      caseId: dispute.id,
      eventType: "DISPUTE_REVIEWED",
      actorId: input.userId,
      payload: { packet_hash: dispute.packet_hash, note_sha256: sha256Hex(note) },
      at: now,
    });
    return { status: "REVIEWED" as const };
  });
}
