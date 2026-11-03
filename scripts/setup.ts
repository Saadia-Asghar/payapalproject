// One-command first run: `npm run setup`.
// 1. Creates .env.local from .env.example if missing (git-ignored, never committed).
// 2. Fills in a signing key and demo password if they are empty.
// 3. Migrates the database and creates the demo accounts.
// 4. Reports which optional keys (PayPal, Anthropic) are still missing.
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivatePem } from "../src/server/crypto/signing.ts";

const ENV = ".env.local";

if (!existsSync(ENV)) {
  copyFileSync(".env.example", ENV);
  console.log(`Created ${ENV} from .env.example`);
}

function readEnv(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(ENV, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) map.set(m[1], m[2].trim());
  }
  return map;
}

function setEnv(key: string, value: string) {
  const text = readFileSync(ENV, "utf8");
  const re = new RegExp(`^${key}=.*$`, "m");
  writeFileSync(ENV, re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`);
}

let env = readEnv();
const generated: string[] = [];
if (!env.get("CW_SIGNING_PRIVATE_KEY")) {
  setEnv("CW_SIGNING_PRIVATE_KEY", Buffer.from(generatePrivatePem()).toString("base64"));
  generated.push("CW_SIGNING_PRIVATE_KEY (new Ed25519 signing key)");
}
if (!env.get("SEED_DEMO_PASSWORD")) {
  setEnv("SEED_DEMO_PASSWORD", randomBytes(12).toString("base64url"));
  generated.push("SEED_DEMO_PASSWORD (demo account password)");
}
env = readEnv();
for (const [k, v] of env) if (v && process.env[k] === undefined) process.env[k] = v;

// Imported after the environment is loaded so the database client sees DATABASE_URL.
const { getDb } = await import("../src/server/db/client.ts");
const { runMigrations } = await import("../src/server/db/migrate.ts");
const { DEMO_USERS, seedDemoAccounts } = await import("../src/server/seed.ts");

const db = await getDb();
const applied = await runMigrations(db);
await seedDemoAccounts(db, process.env.SEED_DEMO_PASSWORD!);
await db.close();

const has = (k: string) => !!env.get(k);
const line = (ok: boolean, text: string) => console.log(`  ${ok ? "✓" : "·"} ${text}`);
console.log("\nCartWitness setup complete.\n");
if (generated.length) console.log(`Generated in ${ENV}: ${generated.join(", ")}\n`);
line(true, `Database: ${has("DATABASE_URL") ? "PostgreSQL (DATABASE_URL)" : "embedded PGlite in .data/"}${applied.length ? ` — applied ${applied.join(", ")}` : ""}`);
line(true, "Signing key configured");
line(true, `Demo accounts: ${DEMO_USERS.map((u) => u.email).join(", ")} — password is SEED_DEMO_PASSWORD in ${ENV}`);
line(
  has("PAYPAL_CLIENT_ID") && has("PAYPAL_CLIENT_SECRET") && has("NEXT_PUBLIC_PAYPAL_CLIENT_ID"),
  "PayPal sandbox checkout (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, NEXT_PUBLIC_PAYPAL_CLIENT_ID)",
);
line(has("PAYPAL_WEBHOOK_ID"), "PayPal webhooks (PAYPAL_WEBHOOK_ID) — optional");
line(has("ANTHROPIC_API_KEY"), "Claude form suggestions (ANTHROPIC_API_KEY) — optional; a rule-based parser is used without it");
console.log(`\nAdd any missing keys to ${ENV}, then run:  npm run dev   and open http://localhost:3000/setup`);
