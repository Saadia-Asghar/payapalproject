// Database access: real PostgreSQL (e.g. Supabase) when DATABASE_URL is set,
// otherwise an embedded PGlite database under .data/ so a fresh clone runs
// with zero external services. Both speak the same SQL with $1-style params.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { runMigrations } from "./migrate.ts";

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /** Run multi-statement SQL without parameters (migrations only). */
  exec(sql: string): Promise<void>;
  /** Run fn inside a single transaction; rolls back if it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function pgliteDb(pglite: PGlite): Db {
  return {
    async query<T>(text: string, params?: unknown[]) {
      return (await pglite.query(text, params)).rows as T[];
    },
    async exec(sql) {
      await pglite.exec(sql);
    },
    tx(fn) {
      return pglite.transaction((t) =>
        fn({
          query: async <T>(text: string, params?: unknown[]) => {
            // Parameterless calls go through exec so multi-statement SQL works.
            if (!params) {
              const results = await t.exec(text);
              return (results.at(-1)?.rows ?? []) as T[];
            }
            return (await t.query(text, params)).rows as T[];
          },
        }),
      );
    },
    close: () => pglite.close(),
  };
}

export function postgresDb(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  return {
    async query<T>(text: string, params?: unknown[]) {
      return (await pool.query(text, params)).rows as T[];
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: async <T>(text: string, params?: unknown[]) => (await client.query(text, params)).rows as T[],
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

// Survive Next.js dev hot reloads without opening a second embedded database.
const globalForDb = globalThis as unknown as { cwDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!globalForDb.cwDb) {
    globalForDb.cwDb = (async () => {
      const url = process.env.DATABASE_URL;
      if (url) return postgresDb(url);
      const dir = path.join(process.cwd(), ".data", "pglite");
      mkdirSync(dir, { recursive: true });
      const db = pgliteDb(new PGlite(dir));
      // Embedded dev database migrates itself; hosted Postgres uses `npm run db:migrate`.
      await runMigrations(db);
      return db;
    })().catch((err) => {
      globalForDb.cwDb = undefined;
      throw err;
    });
  }
  return globalForDb.cwDb;
}

/** Fresh in-memory database for tests. */
export async function createTestDb(): Promise<Db> {
  const db = pgliteDb(new PGlite());
  await runMigrations(db);
  return db;
}
