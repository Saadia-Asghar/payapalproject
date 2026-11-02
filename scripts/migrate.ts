// Applies pending SQL migrations to DATABASE_URL (or the embedded .data/ database).
import { getDb } from "../src/server/db/client.ts";
import { runMigrations } from "../src/server/db/migrate.ts";

const db = await getDb();
const applied = await runMigrations(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
await db.close();
