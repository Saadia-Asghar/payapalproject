import { z } from "zod";
import { getDb } from "@/server/db/client";
import { api, readJson, requireUser } from "@/server/http";
import { openSampleDispute } from "@/server/services/disputes";
import { ServiceError } from "@/server/services/permissions";

const body = z.strictObject({
  attempt_id: z.string().uuid(),
  reason: z.enum(["NOT_AUTHORIZED", "WRONG_ITEM", "NOT_RECEIVED", "EXCEEDED_INSTRUCTIONS"]),
  complaint: z.string().max(1000).default(""),
});

/** Merchant-only: opens a clearly labelled SAMPLE case and builds its evidence packet. */
export const POST = api(async (req) => {
  const { user } = await requireUser("MERCHANT");
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) throw new ServiceError("BAD_REQUEST", 400, "Invalid dispute request.");
  return openSampleDispute(await getDb(), {
    userId: user.id,
    attemptId: parsed.data.attempt_id,
    reason: parsed.data.reason,
    complaint: parsed.data.complaint,
  });
});
