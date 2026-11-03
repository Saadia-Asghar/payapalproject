// Demo accounts used by `npm run db:seed` and `npm run setup`, and one-click demo buyers for judges.
import { randomBytes } from "node:crypto";
import { hashPassword } from "./auth/password.ts";
import type { Db } from "./db/client.ts";

export const DEMO_USERS = [
  { email: "buyer@demo.cartwitness.test", display_name: "Demo Buyer", role: "BUYER" },
  { email: "merchant@demo.cartwitness.test", display_name: "Demo Sneaker Store", role: "MERCHANT" },
] as const;

/** Creates the demo buyer and merchant (or resets their password) and links the merchant to its store. */
export async function seedDemoAccounts(db: Db, password: string) {
  if (password.length < 10) throw new Error("The demo password must be at least 10 characters.");
  for (const u of DEMO_USERS) {
    await db.query(
      `INSERT INTO users (email, display_name, role, password_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, display_name = EXCLUDED.display_name`,
      [u.email, u.display_name, u.role, await hashPassword(password)],
    );
  }
  await db.query("UPDATE merchants SET owner_user_id = (SELECT id FROM users WHERE email = $1) WHERE id = 'DEMO-SNEAKER-STORE'", [
    "merchant@demo.cartwitness.test",
  ]);
}

/**
 * A fresh, private, passwordless buyer for "Try the demo", so judges never see each other's data.
 * They can add a passkey and sign back in with it; otherwise the account ends with the session.
 */
export async function createDemoBuyer(db: Db) {
  const tag = randomBytes(4).toString("hex");
  const [user] = await db.query<{ id: string; email: string }>(
    "INSERT INTO users (email, display_name, role, is_demo) VALUES ($1, $2, 'BUYER', true) RETURNING id, email",
    [`demo-buyer-${tag}@demo.cartwitness.test`, `Demo buyer ${tag.toUpperCase()}`],
  );
  return user;
}

/** The shared demo merchant (created without a password if the seed has not run). */
export async function ensureDemoMerchant(db: Db) {
  const m = DEMO_USERS[1];
  await db.query("INSERT INTO users (email, display_name, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING", [m.email, m.display_name, m.role]);
  await db.query("UPDATE merchants SET owner_user_id = (SELECT id FROM users WHERE email = $1) WHERE id = 'DEMO-SNEAKER-STORE'", [m.email]);
  const [user] = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [m.email]);
  return user.id;
}
