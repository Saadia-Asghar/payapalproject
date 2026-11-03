import { z } from "zod";
import { approvalOptions, relyingPartyFrom } from "@/server/auth/webauthn";
import { getDb } from "@/server/db/client";
import { api, readJson, requireUser } from "@/server/http";
import { getAttemptDetail } from "@/server/services/carts";
import { ServiceError } from "@/server/services/permissions";

const body = z.strictObject({ cart_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/) });

/** Passkey options whose challenge commits to this exact cart (attempt ID + cart hash). */
export const POST = api(async (req, ctx: RouteContext<"/api/carts/[id]/approve/options">) => {
  const { user } = await requireUser("BUYER");
  const { id } = await ctx.params;
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) throw new ServiceError("BAD_REQUEST", 400, "Invalid request.");
  const db = await getDb();
  const { attempt } = await getAttemptDetail(db, user.id, id);
  if (attempt.verdict !== "ALLOW") throw new ServiceError("NOT_ALLOWED", 409, "Only a cart that matches your permission can be approved.");
  if (attempt.cart_hash !== parsed.data.cart_hash) throw new ServiceError("CART_CHANGED", 409, "This is not the cart you were shown. Please check again.");
  return db.tx((q) =>
    approvalOptions(q, user.id, relyingPartyFrom(req), { purpose: "CART_APPROVAL", cart_attempt_id: attempt.id, cart_hash: attempt.cart_hash }),
  );
});
