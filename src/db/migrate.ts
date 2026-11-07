import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

// Applies src/db/migrations/*.sql in name order, each in its own transaction.
// An applied file whose content changed is an error, never silently re-run.
export async function migrate(ownerUrl: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (await client.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum]),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = done.get(file);
      if (previous) {
        if (previous !== checksum) throw new Error(`Migration ${file} changed after it was applied.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}
