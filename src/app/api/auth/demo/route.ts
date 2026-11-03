import { z } from "zod";
import { createSession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { api, readJson } from "@/server/http";
import { clientIp, rateLimit } from "@/server/ratelimit";
import { createDemoBuyer, ensureDemoMerchant } from "@/server/seed";
import { ServiceError } from "@/server/services/permissions";

const body = z.strictObject({ role: z.enum(["BUYER", "MERCHANT"]) });

/**
 * One-click demo access for judges. BUYER → a fresh private buyer account; MERCHANT → the shared
 * Demo Sneaker Store. Set CW_DEMO_LOGIN=off to disable on a non-demo deployment.
 */
export const POST = api(async (req) => {
  if (process.env.CW_DEMO_LOGIN === "off") throw new ServiceError("NOT_FOUND", 404, "Demo sign-in is disabled.");
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) throw new ServiceError("BAD_REQUEST", 400, "Choose buyer or merchant.");
  if (!rateLimit(`demo:ip:${clientIp(req)}`, 20, 60 * 60_000).ok) {
    throw new ServiceError("RATE_LIMITED", 429, "Too many demo sign-ins from this network. Try again later.");
  }
  const db = await getDb();
  const userId = parsed.data.role === "BUYER" ? (await createDemoBuyer(db)).id : await ensureDemoMerchant(db);
  await createSession(userId);
  return { ok: true, role: parsed.data.role };
});
