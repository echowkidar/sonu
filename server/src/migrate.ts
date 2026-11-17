import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from './db.js';

const LOCK_ID = 727_001; // pg_advisory_lock key: one migrator at a time

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies server/migrations/NNN_name.sql in name order. Each file runs once, inside its own
 * transaction, and is recorded in schema_migrations. Safe to call on every start.
 */
export async function runMigrations(pool: Pool, dir: string, log?: (msg: string) => void): Promise<MigrationResult> {
  const files = (await fs.readdir(dir)).filter((f) => /^\d{3,}_.+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) {
        skipped.push(file);
        continue;
      }
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log?.(`migration applied: ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return { applied, skipped };
}
