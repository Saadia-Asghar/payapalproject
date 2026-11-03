import { getDb } from "@/server/db/client";
import { api, requireUser } from "@/server/http";
import { getPayPal } from "@/server/paypal/client";
import { captureCheckout } from "@/server/services/checkout";

/** Server-side capture after the buyer approved in PayPal; issues the Purchase Passport. */
export const POST = api(async (_req, ctx: RouteContext<"/api/checkout/[paymentOrderId]/capture">) => {
  const { user } = await requireUser("BUYER");
  const { paymentOrderId } = await ctx.params;
  return captureCheckout(await getDb(), getPayPal(), { userId: user.id, paymentOrderId });
});
