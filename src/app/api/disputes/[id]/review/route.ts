import { z } from "zod";
import { getDb } from "@/server/db/client";
import { api, readJson, requireUser } from "@/server/http";
import { reviewDispute } from "@/server/services/disputes";
import { ServiceError } from "@/server/services/permissions";

const body = z.strictObject({ note: z.string().min(3).max(2000) });

/** Merchant reviewer step: records a note and marks the case reviewed (packet is never edited). */
export const POST = api(async (req, ctx: RouteContext<"/api/disputes/[id]/review">) => {
  const { user } = await requireUser("MERCHANT");
  const { id } = await ctx.params;
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) throw new ServiceError("BAD_REQUEST", 400, "Add a short review note.");
  return reviewDispute(await getDb(), { userId: user.id, caseId: id, note: parsed.data.note });
});
