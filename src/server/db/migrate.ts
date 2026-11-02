// Applies db/migrations/*.sql in filename order, each exactly once.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "./client.ts";

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

export async function runMigrations(db: Db): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const name of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
    const didApply = await db.tx(async (q) => {
      // Serialize concurrent migrators on hosted Postgres.
      await q.query("SELECT pg_advisory_xact_lock(727274)");
      const done = await q.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
      if (done.length) return false;
      await q.query(sql);
      await q.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      return true;
    });
    if (didApply) applied.push(name);
  }
  return applied;
}
