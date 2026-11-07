import pg from 'pg';
import type { Config } from '../config.ts';

// Postgres numeric and bigint come back as strings so no precision is lost in JS.
export type Db = { app: pg.Pool; read: pg.Pool };

// allowExitOnIdle lets short-lived processes (CLI, tests) exit without closing pools.
export function createDb(cfg: Pick<Config, 'databaseUrlApp' | 'databaseUrlRead'>, allowExitOnIdle = false): Db {
  return {
    app: new pg.Pool({ connectionString: cfg.databaseUrlApp, max: 8, allowExitOnIdle }),
    read: new pg.Pool({ connectionString: cfg.databaseUrlRead, max: 2, allowExitOnIdle }),
  };
}

export function ownerPool(cfg: Pick<Config, 'databaseUrlOwner'>, allowExitOnIdle = false): pg.Pool {
  return new pg.Pool({ connectionString: cfg.databaseUrlOwner, max: 2, allowExitOnIdle });
}

export type TxOptions = { readOnly?: boolean; statementTimeoutMs?: number };

// Every tenant query runs inside one of these: the company comes from the session,
// and row-level security filters every table on app.company_id.
export async function withCompany<T>(
  pool: pg.Pool,
  companyId: string,
  fn: (tx: pg.PoolClient) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(opts.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query(`SELECT set_config('app.company_id', $1, true)`, [companyId]);
    if (opts.statementTimeoutMs) {
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(opts.statementTimeoutMs)]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

// For tables that are not company-scoped (sign-in, OAuth bookkeeping).
export async function withSystem<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

// One client runs one query at a time (overlapping queries are deprecated in pg), so a
// transaction's independent reads go through this instead of Promise.all.
export async function sequential<T extends unknown[]>(steps: [...{ [K in keyof T]: () => Promise<T[K]> }]): Promise<T> {
  const out: unknown[] = [];
  for (const step of steps) out.push(await step());
  return out as T;
}
