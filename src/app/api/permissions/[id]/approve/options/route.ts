import { z } from "zod";
import { approvalOptions, relyingPartyFrom } from "@/server/auth/webauthn";
import { getDb } from "@/server/db/client";
import { api, readJson, requireUser } from "@/server/http";
import { reviewPermission, ServiceError } from "@/server/services/permissions";

const body = z.strictObject({ terms_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/) });

/** Passkey options whose challenge commits to this permission's policy ID, version and exact terms hash. */
export const POST = api(async (req, ctx: RouteContext<"/api/permissions/[id]/approve/options">) => {
  const { user } = await requireUser("BUYER");
  const { id } = await ctx.params;
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) throw new ServiceError("BAD_REQUEST", 400, "Invalid request.");
  const db = await getDb();
  const prepared = await reviewPermission(db, user.id, id);
  if (prepared.termsHash !== parsed.data.terms_hash) {
    throw new ServiceError("TERMS_CHANGED", 409, "The terms changed after you reviewed them. Please review the latest version again.");
  }
  return db.tx((q) =>
    approvalOptions(q, user.id, relyingPartyFrom(req), {
      purpose: "PERMISSION_APPROVAL",
      policy_id: prepared.policyId,
      version: prepared.version,
      terms_hash: prepared.termsHash,
    }),
  );
});
