import { z } from "zod";
import { verifyPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { api, readJson } from "@/server/http";
import { clientIp, peekRateLimit, rateLimit, resetRateLimit } from "@/server/ratelimit";
import { ServiceError } from "@/server/services/permissions";

const body = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) });

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;

export const POST = api(async (req) => {
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) throw new ServiceError("BAD_CREDENTIALS", 401, "Email or password is incorrect.");
  // Throttle failed attempts per account and per address to slow password guessing.
  const keys = [`login:email:${parsed.data.email}`, `login:ip:${clientIp(req)}`];
  const blocked = keys.map((k) => peekRateLimit(k, MAX_FAILURES, WINDOW_MS)).find((r) => !r.ok);
  if (blocked) throw new ServiceError("RATE_LIMITED", 429, `Too many failed sign-ins. Try again in ${Math.ceil(blocked.retryAfterSec / 60)} min.`);
  const db = await getDb();
  const [user] = await db.query<{ id: string; password_hash: string | null; role: string }>(
    "SELECT id, password_hash, role FROM users WHERE email = $1",
    [parsed.data.email],
  );
  // Same message whether the account exists or not.
  if (!user?.password_hash || !(await verifyPassword(parsed.data.password, user.password_hash))) {
    for (const k of keys) rateLimit(k, MAX_FAILURES, WINDOW_MS);
    throw new ServiceError("BAD_CREDENTIALS", 401, "Email or password is incorrect.");
  }
  resetRateLimit(keys[0]);
  await createSession(user.id);
  return { ok: true, role: user.role };
});
