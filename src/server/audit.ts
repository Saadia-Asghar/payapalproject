// Append-only, hash-chained evidence log.
// Each entry's hash covers the previous entry's hash, so editing or deleting a
// retained entry breaks every later link (tamper-evident, not tamper-proof).
import { canonicalHash } from "./crypto/hash.ts";
import type { Queryable } from "./db/client.ts";

export const GENESIS_HASH = "sha256:" + "0".repeat(64);

export interface AuditInput {
  subjectType: "permission" | "cart" | "payment" | "passport" | "dispute" | "user";
  subjectId: string;
  eventType: string;
  actorId?: string | null;
  caseId?: string | null;
  payload: Record<string, unknown>;
  at?: Date;
}

interface ChainRow {
  seq: string;
  subject_type: string;
  subject_id: string;
  case_id: string | null;
  event_type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
  created_at: Date;
}

interface ChainLink {
  prev_hash: string;
  subject_type: string;
  subject_id: string;
  case_id: string | null;
  event_type: string;
  actor_id: string | null;
  payload_hash: string;
  created_at: string;
}

/** Must run inside a transaction so the chain head can't race. */
export async function appendEvidence(q: Queryable, input: AuditInput): Promise<string> {
  await q.query("SELECT pg_advisory_xact_lock(727275)");
  const [head] = await q.query<{ hash: string }>("SELECT hash FROM evidence_events ORDER BY seq DESC LIMIT 1");
  const link: ChainLink = {
    prev_hash: head?.hash ?? GENESIS_HASH,
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    case_id: input.caseId ?? null,
    event_type: input.eventType,
    actor_id: input.actorId ?? null,
    payload_hash: canonicalHash(input.payload),
    created_at: (input.at ?? new Date()).toISOString(),
  };
  const hash = canonicalHash(link);
  await q.query(
    `INSERT INTO evidence_events
       (subject_type, subject_id, case_id, event_type, actor_id, payload, payload_hash, prev_hash, hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [link.subject_type, link.subject_id, link.case_id, link.event_type, link.actor_id, JSON.stringify(input.payload),
      link.payload_hash, link.prev_hash, hash, link.created_at],
  );
  return hash;
}

/** Recomputes every link from stored payloads. Reports the first broken entry. */
export async function verifyEvidenceChain(q: Queryable): Promise<{ ok: true; length: number } | { ok: false; brokenAt: string }> {
  const rows = await q.query<ChainRow>("SELECT * FROM evidence_events ORDER BY seq ASC");
  let prev = GENESIS_HASH;
  for (const r of rows) {
    const recomputed = canonicalHash({
      prev_hash: prev,
      subject_type: r.subject_type,
      subject_id: r.subject_id,
      case_id: r.case_id,
      event_type: r.event_type,
      actor_id: r.actor_id,
      payload_hash: canonicalHash(r.payload),
      created_at: new Date(r.created_at).toISOString(),
    } satisfies ChainLink);
    if (r.prev_hash !== prev || r.hash !== recomputed) return { ok: false, brokenAt: String(r.seq) };
    prev = r.hash;
  }
  return { ok: true, length: rows.length };
}
