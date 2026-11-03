// Runs before `next build` on Vercel (package.json "vercel-build").
// - DATABASE_URL set        → apply pending migrations (idempotent, safe on every deploy)
// - SEED_DEMO_PASSWORD set  → create/refresh the demo buyer + merchant accounts
// - CW_SIGNING_PRIVATE_KEY  → warn if missing (the app refuses to sign without it in production)
// Never fails the build for missing optional keys; fails only if the database is set but unreachable.
const warn = (m: string) => console.warn(`[deploy-prepare] ⚠ ${m}`);
const info = (m: string) => console.log(`[deploy-prepare] ${m}`);

if (!process.env.CW_SIGNING_PRIVATE_KEY) warn("CW_SIGNING_PRIVATE_KEY is not set — approvals will fail at runtime. Generate one with `npm run keys:generate`.");
if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET || !process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID) {
  info("PayPal keys not set — checkout will show 'not configured' until they are added.");
}

if (!process.env.DATABASE_URL) {
  warn("DATABASE_URL is not set — skipping migrations. The deployed app needs a PostgreSQL database (e.g. Supabase).");
} else {
  const { getDb } = await import("../src/server/db/client.ts");
  const { runMigrations } = await import("../src/server/db/migrate.ts");
  const db = await getDb();
  const applied = await runMigrations(db);
  info(applied.length ? `applied migrations: ${applied.join(", ")}` : "database schema is up to date");
  if (process.env.SEED_DEMO_PASSWORD) {
    const { seedDemoAccounts } = await import("../src/server/seed.ts");
    await seedDemoAccounts(db, process.env.SEED_DEMO_PASSWORD);
    info("demo accounts ready (buyer@ / merchant@demo.cartwitness.test)");
  } else {
    info("SEED_DEMO_PASSWORD not set — demo accounts not created/updated.");
  }
  await db.close();
}

// Marks this script as an ES module so top-level await type-checks.
export {};
