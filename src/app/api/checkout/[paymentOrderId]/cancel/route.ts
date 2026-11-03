import { getDb } from "@/server/db/client";
import { api, requireUser } from "@/server/http";
import { cancelCheckout } from "@/server/services/checkout";

/** The buyer closed the PayPal window: mark the unpaid checkout cancelled. */
export const POST = api(async (_req, ctx: RouteContext<"/api/checkout/[paymentOrderId]/cancel">) => {
  const { user } = await requireUser("BUYER");
  const { paymentOrderId } = await ctx.params;
  return cancelCheckout(await getDb(), { userId: user.id, paymentOrderId });
});
