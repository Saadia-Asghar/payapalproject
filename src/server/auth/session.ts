import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { sha256Hex } from "../crypto/hash.ts";
import { getDb } from "../db/client.ts";

export const SESSION_COOKIE = "cw_session";
const SESSION_HOURS = 12;

export interface SessionUser {
  sessionId: string;
  user: { id: string; email: string; display_name: string; role: "BUYER" | "MERCHANT" };
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_HOURS * 3_600_000);
  const db = await getDb();
  await db.query("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)", [sha256Hex(token), userId, expires.toISOString()]);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  });
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  // Session state is always request-time data: never prerender past this point.
  await connection();
  if (!token) return null;
  const db = await getDb();
  const [row] = await db.query<SessionUser["user"] & { session_id: string }>(
    `SELECT s.id AS session_id, u.id, u.email, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [sha256Hex(token)],
  );
  if (!row) return null;
  const { session_id, ...user } = row;
  return { sessionId: session_id, user };
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.query("DELETE FROM sessions WHERE id = $1", [sha256Hex(token)]);
  }
  store.delete(SESSION_COOKIE);
}
