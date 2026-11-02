import { z } from "zod";
import { verifyPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { api, readJson } from "@/server/http";
import { ServiceError } from "@/server/services/permissions";

const body = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) });

export const POST = api(async (req) => {
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) throw new ServiceError("BAD_CREDENTIALS", 401, "Email or password is incorrect.");
  const db = await getDb();
  const [user] = await db.query<{ id: string; password_hash: string | null; role: string }>(
    "SELECT id, password_hash, role FROM users WHERE email = $1",
    [parsed.data.email],
  );
  // Same message whether the account exists or not.
  if (!user?.password_hash || !(await verifyPassword(parsed.data.password, user.password_hash))) {
    throw new ServiceError("BAD_CREDENTIALS", 401, "Email or password is incorrect.");
  }
  await createSession(user.id);
  return { ok: true, role: user.role };
});
