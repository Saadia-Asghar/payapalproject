import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyEvidenceChain } from "../src/server/audit.ts";
import { generatePrivatePem, keyFromPrivatePem } from "../src/server/crypto/signing.ts";
import { createTestDb, type Db } from "../src/server/db/client.ts";
import {
  approvePermission,
  assertVersionUsable,
  createPermission,
  getPermissionDetail,
  reviewPermission,
  revokePermission,
  saveDraft,
  ServiceError,
} from "../src/server/services/permissions.ts";
import { NOW, validForm } from "./fixtures.ts";

const signingKey = keyFromPrivatePem(generatePrivatePem());
const ALL_CONSENTS = { checked_terms: true, ai_may_err: true, no_charge_yet: true };

let db: Db;
let buyer: string;
let otherBuyer: string;

async function makeUser(email: string) {
  const [u] = await db.query<{ id: string }>(
    "INSERT INTO users (email, display_name, role) VALUES ($1, $1, 'BUYER') RETURNING id",
    [email],
  );
  return u.id;
}

async function expectServiceError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ServiceError && e.code === code);
}

async function approvedPermission() {
  const { id } = await createPermission(db, buyer, validForm());
  const review = await reviewPermission(db, buyer, id, NOW);
  const approval = await approvePermission(db, {
    userId: buyer, sessionId: "s1", permissionId: id, termsHash: review.termsHash, consents: ALL_CONSENTS, now: NOW, signingKey,
  });
  return { id, review, approval };
}

beforeEach(async () => {
  db = await createTestDb();
  buyer = await makeUser("buyer@example.test");
  otherBuyer = await makeUser("other@example.test");
});
afterEach(async () => db.close());

describe("permission approval", () => {
  it("stores the exact reviewed terms as signed, immutable version 1", async () => {
    const { id, review, approval } = await approvedPermission();
    expect(approval).toMatchObject({ policyId: "CW-POL-001", version: 1, termsHash: review.termsHash });

    const detail = await getPermissionDetail(db, buyer, id, NOW);
    expect(detail.effectiveStatus).toBe("ACTIVE");
    expect(detail.active?.terms.max_total).toEqual({ currency: "USD", value: "150.00" });
    expect(detail.active?.summary_text).toBe(review.summary);
    expect(detail.active?.integrity).toEqual({ termsIntact: true, signatureValid: true, passkeyValid: null });
  });

  it("refuses approval without all three consent checkboxes", async () => {
    const { id } = await createPermission(db, buyer, validForm());
    const review = await reviewPermission(db, buyer, id, NOW);
    await expectServiceError(
      approvePermission(db, { userId: buyer, sessionId: "s", permissionId: id, termsHash: review.termsHash,
        consents: { checked_terms: true, ai_may_err: true }, now: NOW, signingKey }),
      "CONSENT_REQUIRED",
    );
  });

  it("refuses an incomplete form at review time", async () => {
    const { id } = await createPermission(db, buyer, { ...validForm(), max_total: "" });
    await expectServiceError(reviewPermission(db, buyer, id, NOW), "INVALID_TERMS");
  });

  it("refuses an unknown seller id even if the form is otherwise valid", async () => {
    const { id } = await createPermission(db, buyer, { ...validForm(), merchant_ids: ["EVIL-LOOKALIKE-STORE"] });
    await expectServiceError(reviewPermission(db, buyer, id, NOW), "INVALID_TERMS");
  });

  it("refuses approval when the draft changed after review", async () => {
    const { id } = await createPermission(db, buyer, validForm());
    const review = await reviewPermission(db, buyer, id, NOW);
    await saveDraft(db, buyer, id, { ...validForm(), max_total: "500" }, NOW);
    await expectServiceError(
      approvePermission(db, { userId: buyer, sessionId: "s", permissionId: id, termsHash: review.termsHash, consents: ALL_CONSENTS, now: NOW, signingKey }),
      "TERMS_CHANGED",
    );
  });

  it("refuses approval of a hash the buyer was never shown", async () => {
    const { id } = await createPermission(db, buyer, validForm());
    await reviewPermission(db, buyer, id, NOW);
    await expectServiceError(
      approvePermission(db, { userId: buyer, sessionId: "s", permissionId: id, termsHash: "sha256:forged", consents: ALL_CONSENTS, now: NOW, signingKey }),
      "TERMS_CHANGED",
    );
  });

  it("does not let one buyer read or approve another buyer's permission", async () => {
    const { id } = await createPermission(db, buyer, validForm());
    const review = await reviewPermission(db, buyer, id, NOW);
    await expectServiceError(getPermissionDetail(db, otherBuyer, id, NOW), "NOT_FOUND");
    await expectServiceError(
      approvePermission(db, { userId: otherBuyer, sessionId: "s", permissionId: id, termsHash: review.termsHash, consents: ALL_CONSENTS, now: NOW, signingKey }),
      "NOT_FOUND",
    );
  });

  it("cannot approve the same review twice", async () => {
    const { id, review } = await approvedPermission();
    await expectServiceError(
      approvePermission(db, { userId: buyer, sessionId: "s", permissionId: id, termsHash: review.termsHash, consents: ALL_CONSENTS, now: NOW, signingKey }),
      "INVALID_TERMS",
    );
  });
});

describe("versioning and immutability", () => {
  it("creates version 2 on edit and leaves version 1 untouched", async () => {
    const { id, review: v1 } = await approvedPermission();
    await saveDraft(db, buyer, id, { ...validForm(), max_total: "175.00" }, NOW);
    const v2review = await reviewPermission(db, buyer, id, NOW);
    expect(v2review.version).toBe(2);
    expect(v2review.termsHash).not.toBe(v1.termsHash);
    await approvePermission(db, { userId: buyer, sessionId: "s", permissionId: id, termsHash: v2review.termsHash, consents: ALL_CONSENTS, now: NOW, signingKey });

    const detail = await getPermissionDetail(db, buyer, id, NOW);
    expect(detail.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(detail.versions[1].terms_hash).toBe(v1.termsHash);
    expect(detail.versions[1].terms.max_total.value).toBe("150.00");
    expect(detail.active?.version).toBe(2);
  });

  it("blocks UPDATE and DELETE of approved versions at the database level", async () => {
    await approvedPermission();
    await expect(db.query("UPDATE permission_versions SET terms_hash = 'sha256:tampered'")).rejects.toThrow(/CW_IMMUTABLE/);
    await expect(db.query("DELETE FROM permission_versions")).rejects.toThrow(/CW_IMMUTABLE/);
  });

  it("detects a tampered version even if the trigger were bypassed", async () => {
    const { id } = await approvedPermission();
    await db.exec("ALTER TABLE permission_versions DISABLE TRIGGER permission_versions_immutable");
    await db.query(`UPDATE permission_versions SET canonical_json = replace(canonical_json, '150.00', '999.00')`);
    const detail = await getPermissionDetail(db, buyer, id, NOW);
    expect(detail.active?.integrity.termsIntact).toBe(false);
  });

  it("keeps an intact hash chain of approval and revocation events", async () => {
    const { id } = await approvedPermission();
    await revokePermission(db, buyer, id, NOW);
    expect(await verifyEvidenceChain(db)).toEqual({ ok: true, length: 2 });
    await expect(db.query("DELETE FROM evidence_events")).rejects.toThrow(/CW_IMMUTABLE/);
  });
});

describe("usability gate for later checkout phases", () => {
  async function activeVersionId(permissionId: string) {
    const [v] = await db.query<{ id: string }>(
      "SELECT v.id FROM permission_versions v JOIN permissions p ON p.id = v.permission_id AND v.version = p.active_version WHERE p.id = $1",
      [permissionId],
    );
    return v.id;
  }

  it("allows an active, unexpired permission", async () => {
    const { id } = await approvedPermission();
    await expect(assertVersionUsable(db, await activeVersionId(id), NOW)).resolves.toBeTruthy();
  });

  it("rejects a revoked permission", async () => {
    const { id } = await approvedPermission();
    const vid = await activeVersionId(id);
    await revokePermission(db, buyer, id, NOW);
    await expectServiceError(assertVersionUsable(db, vid, NOW), "REVOKED");
    await expectServiceError(saveDraft(db, buyer, id, validForm(), NOW), "NOT_EDITABLE");
  });

  it("rejects an expired permission", async () => {
    const { id } = await approvedPermission();
    const later = new Date("2026-11-07T00:00:00Z");
    await expectServiceError(assertVersionUsable(db, await activeVersionId(id), later), "EXPIRED");
    expect((await getPermissionDetail(db, buyer, id, later)).effectiveStatus).toBe("EXPIRED");
  });

  it("rejects a superseded version", async () => {
    const { id } = await approvedPermission();
    const v1 = await activeVersionId(id);
    await saveDraft(db, buyer, id, { ...validForm(), quantity: 2 }, NOW);
    const r = await reviewPermission(db, buyer, id, NOW);
    await approvePermission(db, { userId: buyer, sessionId: "s", permissionId: id, termsHash: r.termsHash, consents: ALL_CONSENTS, now: NOW, signingKey });
    await expectServiceError(assertVersionUsable(db, v1, NOW), "SUPERSEDED");
  });
});
