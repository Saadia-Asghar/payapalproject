import { z } from "zod";
import { getDb } from "@/server/db/client";
import { api, readJson, requireUser } from "@/server/http";
import { approveCart } from "@/server/services/carts";
import { ServiceError } from "@/server/services/permissions";

const body = z.strictObject({ cart_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/) });

/** The buyer approves the exact cart they were shown, identified by its hash. */
export const POST = api(async (req, ctx: RouteContext<"/api/carts/[id]/approve">) => {
  const { user } = await requireUser("BUYER");
  const { id } = await ctx.params;
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) throw new ServiceError("BAD_REQUEST", 400, "Invalid approval request.");
  return approveCart(await getDb(), { userId: user.id, attemptId: id, cartHash: parsed.data.cart_hash });
});
