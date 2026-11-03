// Self-service accounts: sign-up rules, password changes and session control.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { passwordProblem } from "../src/lib/auth/password-rules.ts";
import { verifyPassword } from "../src/server/auth/password.ts";
import { createTestDb, type Db } from "../src/server/db/client.ts";
import { createDemoBuyer } from "../src/server/seed.ts";
import { changePassword, signOutOtherSessions, signUp } from "../src/server/services/accounts.ts";
import { ServiceError } from "../src/server/services/permissions.ts";

let db: Db;
const good = "correct horse battery";

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ServiceError && e.code === code);
}
const addSession = (id: string, userId: string) =>
  db.query("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [id, userId]);
const sessionIds = async (userId: string) => (await db.query<{ id: string }>("SELECT id FROM sessions WHERE user_id = $1 ORDER BY id", [userId])).map((r) => r.id);

beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => db.close());

describe("password rules", () => {
  it("rejects short, common, repeated and email-based passwords", () => {
    expect(passwordProblem("short")).toMatch(/at least 10/);
    expect(passwordProblem("password123")).toMatch(/common/);
    expect(passwordProblem("aaaaaaaaaaaa")).toMatch(/common/);
    expect(passwordProblem("maria-secret-2026", "maria@example.com")).toMatch(/email/);
    expect(passwordProblem(good, "maria@example.com")).toBeNull();
  });
});

describe("sign-up", () => {
  it("creates a buyer with a hashed password and normalised email", async () => {
    const u = await signUp(db, { email: "  Maria@Example.COM ", displayName: "  Maria   Lopez ", password: good });
    expect(u.role).toBe("BUYER");
    const [row] = await db.query<{ email: string; display_name: string; role: string; password_hash: string; is_demo: boolean }>(
      "SELECT email, display_name, role, password_hash, is_demo FROM users WHERE id = $1",
      [u.id],
    );
    expect(row).toMatchObject({ email: "maria@example.com", display_name: "Maria Lopez", role: "BUYER", is_demo: false });
    expect(row.password_hash).not.toContain(good);
    expect(await verifyPassword(good, row.password_hash)).toBe(true);
    const [ev] = await db.query<{ event_type: string }>("SELECT event_type FROM evidence_events WHERE subject_id = $1", [u.id]);
    expect(ev.event_type).toBe("ACCOUNT_CREATED");
  });

  it("refuses duplicates (case-insensitive), invalid input and reserved demo addresses", async () => {
    await signUp(db, { email: "maria@example.com", displayName: "Maria", password: good });
    await expectCode(signUp(db, { email: "MARIA@example.com", displayName: "Other", password: good }), "EMAIL_TAKEN");
    await expect(signUp(db, { email: "not-an-email", displayName: "", password: "short" })).rejects.toSatisfy(
      (e: unknown) => e instanceof ServiceError && e.code === "INVALID_SIGNUP" && ["email", "display_name", "password"].every((k) => k in (e.details as object)),
    );
    await expectCode(signUp(db, { email: "x@demo.cartwitness.test", displayName: "X", password: good }), "INVALID_SIGNUP");
  });
});

describe("password change and sessions", () => {
  it("requires the current password, then ends every other session", async () => {
    const u = await signUp(db, { email: "maria@example.com", displayName: "Maria", password: good });
    await addSession("s-this", u.id);
    await addSession("s-other", u.id);
    await expectCode(changePassword(db, { userId: u.id, sessionId: "s-this", current: "wrong password!", next: "a brand new passphrase" }), "BAD_CREDENTIALS");
    await expectCode(changePassword(db, { userId: u.id, sessionId: "s-this", current: good, next: "short" }), "WEAK_PASSWORD");
    const r = await changePassword(db, { userId: u.id, sessionId: "s-this", current: good, next: "a brand new passphrase" });
    expect(r.otherSessionsEnded).toBe(1);
    expect(await sessionIds(u.id)).toEqual(["s-this"]);
    const [{ password_hash }] = await db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [u.id]);
    expect(await verifyPassword("a brand new passphrase", password_hash)).toBe(true);
  });

  it("lets a passwordless demo account set a first password", async () => {
    const demo = await createDemoBuyer(db);
    await addSession("d1", demo.id);
    await changePassword(db, { userId: demo.id, sessionId: "d1", next: "my own passphrase" });
    const [{ password_hash }] = await db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [demo.id]);
    expect(await verifyPassword("my own passphrase", password_hash)).toBe(true);
  });

  it("signs out other sessions on request, never someone else's", async () => {
    const a = await signUp(db, { email: "a@example.com", displayName: "A", password: good });
    const b = await signUp(db, { email: "b@example.com", displayName: "B", password: good });
    await addSession("a1", a.id);
    await addSession("a2", a.id);
    await addSession("b1", b.id);
    expect((await signOutOtherSessions(db, a.id, "a1")).otherSessionsEnded).toBe(1);
    expect(await sessionIds(a.id)).toEqual(["a1"]);
    expect(await sessionIds(b.id)).toEqual(["b1"]);
  });
});
