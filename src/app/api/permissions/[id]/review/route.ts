import { getDb } from "@/server/db/client";
import { api, requireUser } from "@/server/http";
import { reviewPermission } from "@/server/services/permissions";

/** Validates the draft and returns the exact canonical terms + hash the buyer will approve. */
export const POST = api(async (_req, ctx: RouteContext<"/api/permissions/[id]/review">) => {
  const { user } = await requireUser("BUYER");
  const { id } = await ctx.params;
  return reviewPermission(await getDb(), user.id, id);
});
