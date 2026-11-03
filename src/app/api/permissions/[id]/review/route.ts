import { hasPasskey } from "@/server/auth/webauthn";
import { getDb } from "@/server/db/client";
import { api, requireUser } from "@/server/http";
import { reviewPermission } from "@/server/services/permissions";

/** Validates the draft and returns the exact canonical terms + hash the buyer will approve. */
export const POST = api(async (_req, ctx: RouteContext<"/api/permissions/[id]/review">) => {
  const { user } = await requireUser("BUYER");
  const { id } = await ctx.params;
  const db = await getDb();
  const review = await reviewPermission(db, user.id, id);
  return { ...review, hasPasskey: await hasPasskey(db, user.id) };
});
