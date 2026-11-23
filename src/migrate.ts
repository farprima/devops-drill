import { readdir, readFile } from "node:fs/promises";
import type pg from "pg";
import { log } from "./log.js";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);
// Any constant works; it only has to be the same for every instance of the app.
const LOCK_ID = 727_001;

/**
 * Applies migrations/*.sql in name order, each once, inside a transaction.
 * The advisory lock makes it safe when several replicas start at the same time.
 */
export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((row) => row.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      log.info("migration applied", { file });
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    client.release();
  }
}
