import { getDb } from "@/server/db/client";
import { api, readJson, requireUser } from "@/server/http";
import { updateProduct } from "@/server/services/catalog";

/** Merchant-only: change price, shipping or stock of one of their own products. */
export const PUT = api(async (req, ctx: RouteContext<"/api/merchant/catalog/[sku]">) => {
  const { user } = await requireUser("MERCHANT");
  const { sku } = await ctx.params;
  return updateProduct(await getDb(), { userId: user.id, sku, update: await readJson(req) });
});
