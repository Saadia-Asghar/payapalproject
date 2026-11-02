import { getDb } from "@/server/db/client";
import { api, requireUser } from "@/server/http";
import { getAttemptDetail } from "@/server/services/carts";

export const GET = api(async (_req, ctx: RouteContext<"/api/carts/[id]">) => {
  const { user } = await requireUser("BUYER");
  const { id } = await ctx.params;
  return getAttemptDetail(await getDb(), user.id, id);
});
