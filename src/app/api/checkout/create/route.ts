import { z } from "zod";
import { getDb } from "@/server/db/client";
import { api, readJson, requireUser } from "@/server/http";
import { getPayPal } from "@/server/paypal/client";
import { startCheckout } from "@/server/services/checkout";
import { ServiceError } from "@/server/services/permissions";

const body = z.strictObject({ attempt_id: z.string().uuid() });

/** Policy gate + PayPal Create Order for an exact, buyer-approved cart. Idempotent. */
export const POST = api(async (req) => {
  const { user } = await requireUser("BUYER");
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) throw new ServiceError("BAD_REQUEST", 400, "Invalid checkout request.");
  return startCheckout(await getDb(), getPayPal(), { userId: user.id, attemptId: parsed.data.attempt_id });
});
