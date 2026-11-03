// Creates (or resets the password of) the demo buyer and merchant accounts.
// The password comes from SEED_DEMO_PASSWORD; if unset, a random one is generated and
// printed once. It is never written to the repository.
import { randomBytes } from "node:crypto";
import { getDb } from "../src/server/db/client.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { DEMO_USERS, seedDemoAccounts } from "../src/server/seed.ts";

const password = process.env.SEED_DEMO_PASSWORD || randomBytes(12).toString("base64url");

const db = await getDb();
await runMigrations(db);
await seedDemoAccounts(db, password);
await db.close();

console.log("Demo accounts ready:");
for (const u of DEMO_USERS) console.log(`  ${u.role.padEnd(8)} ${u.email}`);
console.log(process.env.SEED_DEMO_PASSWORD ? "  password: (from SEED_DEMO_PASSWORD)" : `  password: ${password}   <- generated; shown once`);
