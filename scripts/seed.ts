// Creates (or resets the password of) the demo buyer and merchant accounts.
// The password comes from SEED_DEMO_PASSWORD; if unset, a random one is generated and
// printed once. It is never written to the repository.
import { randomBytes } from "node:crypto";
import { hashPassword } from "../src/server/auth/password.ts";
import { getDb } from "../src/server/db/client.ts";
import { runMigrations } from "../src/server/db/migrate.ts";

const DEMO_USERS = [
  { email: "buyer@demo.cartwitness.test", display_name: "Demo Buyer", role: "BUYER" },
  { email: "merchant@demo.cartwitness.test", display_name: "Demo Sneaker Store", role: "MERCHANT" },
] as const;

const password = process.env.SEED_DEMO_PASSWORD || randomBytes(12).toString("base64url");
if (password.length < 10) throw new Error("SEED_DEMO_PASSWORD must be at least 10 characters.");

const db = await getDb();
await runMigrations(db);
for (const u of DEMO_USERS) {
  await db.query(
    `INSERT INTO users (email, display_name, role, password_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, display_name = EXCLUDED.display_name`,
    [u.email, u.display_name, u.role, await hashPassword(password)],
  );
}
await db.query(
  "UPDATE merchants SET owner_user_id = (SELECT id FROM users WHERE email = $1) WHERE id = 'DEMO-SNEAKER-STORE'",
  ["merchant@demo.cartwitness.test"],
);
await db.close();

console.log("Demo accounts ready:");
for (const u of DEMO_USERS) console.log(`  ${u.role.padEnd(8)} ${u.email}`);
console.log(process.env.SEED_DEMO_PASSWORD ? "  password: (from SEED_DEMO_PASSWORD)" : `  password: ${password}   <- generated; shown once`);
