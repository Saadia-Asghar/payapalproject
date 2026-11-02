import { getDb } from "@/server/db/client";
import { api, requireUser } from "@/server/http";
import { revokePermission } from "@/server/services/permissions";

export const POST = api(async (_req, ctx: RouteContext<"/api/permissions/[id]/revoke">) => {
  const { user } = await requireUser("BUYER");
  const { id } = await ctx.params;
  return revokePermission(await getDb(), user.id, id);
});
