import type pg from 'pg';
import { ensureCompanyPages } from '../ops/wiki/bootstrap.ts';

// Runs after a company is created: starter wiki pages (index, current-status, rules).
export async function companyStarterPages(owner: pg.Pool, companyId: string): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.company_id', $1, true)`, [companyId]);
    await ensureCompanyPages(client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
