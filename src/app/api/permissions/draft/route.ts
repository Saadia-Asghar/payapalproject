import { z } from "zod";
import { suggestDraft } from "@/server/ai/draft";
import { getDb } from "@/server/db/client";
import { api, readJson, requireUser } from "@/server/http";
import { rateLimit } from "@/server/ratelimit";
import { listMerchants, ServiceError } from "@/server/services/permissions";

const body = z.strictObject({
  request_text: z.string().trim().min(5).max(1000),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Suggests Permission Form values from the buyer's plain-English request. Nothing is saved or approved here. */
export const POST = api(async (req) => {
  const { user } = await requireUser("BUYER");
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) throw new ServiceError("BAD_REQUEST", 400, "Describe what you want in at least a few words.");
  const limit = rateLimit(`draft:${user.id}`, 10, 60_000);
  if (!limit.ok) throw new ServiceError("RATE_LIMITED", 429, `Too many suggestion requests. Try again in ${limit.retryAfterSec}s.`);
  const merchants = await listMerchants(await getDb());
  return suggestDraft(parsed.data.request_text, { today: parsed.data.today, merchants });
});
