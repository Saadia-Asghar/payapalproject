import { z } from "zod";
import { createSession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { api, readJson } from "@/server/http";
import { clientIp, rateLimit } from "@/server/ratelimit";
import { signUp } from "@/server/services/accounts";
import { ServiceError } from "@/server/services/permissions";

const body = z.strictObject({
  email: z.string().max(200),
  display_name: z.string().max(200),
  password: z.string().max(200),
});

/** Creates a buyer account and signs it in. */
export const POST = api(async (req) => {
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) throw new ServiceError("BAD_REQUEST", 400, "Invalid sign-up request.");
  if (!rateLimit(`signup:ip:${clientIp(req)}`, 10, 60 * 60_000).ok) {
    throw new ServiceError("RATE_LIMITED", 429, "Too many new accounts from this network. Try again later.");
  }
  const db = await getDb();
  const user = await signUp(db, { email: parsed.data.email, displayName: parsed.data.display_name, password: parsed.data.password });
  await createSession(user.id);
  return { ok: true, role: user.role };
});
