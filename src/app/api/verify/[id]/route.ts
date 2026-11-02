import { getDb } from "@/server/db/client";
import { api } from "@/server/http";
import { publicVerify } from "@/server/services/passports";

/** Public, redacted integrity result for a Purchase Passport id. */
export const GET = api(async (_req, ctx: RouteContext<"/api/verify/[id]">) => {
  const { id } = await ctx.params;
  return publicVerify(await getDb(), id);
});
