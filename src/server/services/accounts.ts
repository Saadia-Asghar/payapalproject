// Self-service accounts: sign-up, password change, and ending other sessions.
// New accounts are buyers. Merchant workspaces are tied to a verified store, so they are not self-service.
import { appendEvidence } from "../audit.ts";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import { sha256Hex } from "../crypto/hash.ts";
import type { Db } from "../db/client.ts";
import { ServiceError } from "../errors.ts";
import { passwordProblem } from "../../lib/auth/password-rules.ts";

const RESERVED_DOMAIN = "@demo.cartwitness.test";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function signUp(db: Db, input: { email: string; displayName: string; password: string }) {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim().replace(/\s+/g, " ");
  const errors: Record<string, string> = {};
  if (!EMAIL_RE.test(email) || email.length > 200) errors.email = "Enter a valid email address.";
  else if (email.endsWith(RESERVED_DOMAIN)) errors.email = "This address is reserved for demo accounts.";
  if (displayName.length < 1 || displayName.length > 80) errors.display_name = "Enter your name (up to 80 characters).";
  const weak = passwordProblem(input.password, email);
  if (weak) errors.password = weak;
  if (Object.keys(errors).length) throw new ServiceError("INVALID_SIGNUP", 422, "Please fix the highlighted fields.", errors);

  const passwordHash = await hashPassword(input.password);
  return db.tx(async (q) => {
    const rows = await q.query<{ id: string }>(
      `INSERT INTO users (email, display_name, role, auth_method, password_hash) VALUES ($1, $2, 'BUYER', 'PASSWORD', $3)
       ON CONFLICT (email) DO NOTHING RETURNING id`,
      [email, displayName, passwordHash],
    );
    if (!rows.length) {
      throw new ServiceError("EMAIL_TAKEN", 409, "An account with this email already exists. Sign in instead.", { email: "Already registered." });
    }
    await appendEvidence(q, {
      subjectType: "user",
      subjectId: rows[0].id,
      eventType: "ACCOUNT_CREATED",
      actorId: rows[0].id,
      payload: { email_sha256: sha256Hex(email), role: "BUYER" },
    });
    return { id: rows[0].id, email, role: "BUYER" as const };
  });
}

/**
 * Sets a new password. Accounts that already have one must confirm the current password;
 * passwordless accounts (demo or passkey-only) may set a first one. Other sessions are ended.
 */
export async function changePassword(db: Db, input: { userId: string; sessionId: string; current?: string; next: string }) {
  const [user] = await db.query<{ email: string; password_hash: string | null }>("SELECT email, password_hash FROM users WHERE id = $1", [input.userId]);
  if (!user) throw new ServiceError("NOT_FOUND", 404, "Account not found.");
  if (user.password_hash && !(input.current && (await verifyPassword(input.current, user.password_hash)))) {
    throw new ServiceError("BAD_CREDENTIALS", 401, "Your current password is incorrect.", { current: "Incorrect." });
  }
  const weak = passwordProblem(input.next, user.email);
  if (weak) throw new ServiceError("WEAK_PASSWORD", 422, weak, { next: weak });
  const hash = await hashPassword(input.next);
  return db.tx(async (q) => {
    await q.query("UPDATE users SET password_hash = $2 WHERE id = $1", [input.userId, hash]);
    const ended = await q.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2 RETURNING id", [input.userId, input.sessionId]);
    await appendEvidence(q, {
      subjectType: "user",
      subjectId: input.userId,
      eventType: user.password_hash ? "PASSWORD_CHANGED" : "PASSWORD_SET",
      actorId: input.userId,
      payload: { other_sessions_ended: ended.length },
    });
    return { ok: true, otherSessionsEnded: ended.length };
  });
}

export async function signOutOtherSessions(db: Db, userId: string, sessionId: string) {
  const ended = await db.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2 RETURNING id", [userId, sessionId]);
  return { otherSessionsEnded: ended.length };
}

export async function accountSummary(db: Db, userId: string) {
  const [row] = await db.query<{ has_password: boolean; is_demo: boolean; sessions: number; created_at: Date }>(
    `SELECT (u.password_hash IS NOT NULL) AS has_password, u.is_demo, u.created_at,
            (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now()) AS sessions
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  return row;
}
