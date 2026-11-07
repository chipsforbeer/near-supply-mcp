import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.ts';
import { createDb, ownerPool, type Db } from '../../src/db/pool.ts';
import { loadConfig, type Config } from '../../src/config.ts';
import { companyStarterPages } from '../../src/admin/company-setup.ts';
import type { Scope } from '../../src/ops/types.ts';

const SUPERUSER_URL = process.env.PG_SUPERUSER_URL ?? '';
const DBNAME = process.env.TEST_DATABASE ?? 'sim_test';
const PASSWORDS = { sim_owner: 'test-only-owner', sim_app: 'test-only-app', sim_read: 'test-only-read' } as const;
type Role = keyof typeof PASSWORDS;

export function roleUrl(role: Role | 'postgres', db = DBNAME): string {
  const u = new URL(SUPERUSER_URL);
  if (role !== 'postgres') {
    u.username = role;
    u.password = PASSWORDS[role];
  }
  u.pathname = `/${db}`;
  return u.toString();
}

let resetPromise: Promise<void> | null = null;

// Each test file runs in its own process; the first call drops and rebuilds the database.
export function resetTestDatabase(): Promise<void> {
  if (!SUPERUSER_URL) throw new Error('PG_SUPERUSER_URL is not set; run tests with npm test.');
  resetPromise ??= doReset();
  return resetPromise;
}

async function doReset(): Promise<void> {
  const admin = new pg.Client({ connectionString: SUPERUSER_URL });
  await admin.connect();
  try {
    for (const [role, password] of Object.entries(PASSWORDS)) {
      const found = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (!found.rowCount) await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    }
    await admin.query(`DROP DATABASE IF EXISTS ${DBNAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DBNAME} OWNER sim_owner`);
  } finally {
    await admin.end();
  }
  const inDb = new pg.Client({ connectionString: roleUrl('postgres') });
  await inDb.connect();
  try {
    await inDb.query('GRANT USAGE ON SCHEMA public TO sim_app, sim_read');
    await inDb.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  } finally {
    await inDb.end();
  }
  await migrate(roleUrl('sim_owner'));
}

let cachedConfig: Config | null = null;
export function testConfig(): Config {
  cachedConfig ??= loadConfig({
    ...process.env,
    DATABASE_URL_APP: roleUrl('sim_app'),
    DATABASE_URL_READ: roleUrl('sim_read'),
    DATABASE_URL_OWNER: roleUrl('sim_owner'),
  });
  return cachedConfig;
}

let cachedDb: Db | null = null;
export function testDb(): Db {
  cachedDb ??= createDb(testConfig(), true);
  return cachedDb;
}

let cachedOwner: pg.Pool | null = null;
export function testOwnerPool(): pg.Pool {
  cachedOwner ??= ownerPool(testConfig(), true);
  return cachedOwner;
}

// Creates a company (unless one is given) and a user with a membership in it.
export async function createCompanyWithUser(
  _db: Db,
  opts: { companyId?: string; scopes?: Scope[]; name?: string },
): Promise<{ companyId: string; userId: string; email: string }> {
  const owner = testOwnerPool();
  let companyId = opts.companyId;
  if (!companyId) {
    const slug = `c-${randomUUID().slice(0, 8)}`;
    const c = await owner.query('INSERT INTO company (name, slug) VALUES ($1, $2) RETURNING id', [opts.name ?? `Company ${slug}`, slug]);
    companyId = c.rows[0].id as string;
    await companyStarterPages(owner, companyId);
  }
  const email = `user-${randomUUID()}@example.test`;
  const u = await owner.query('INSERT INTO app_user (email, display_name) VALUES ($1, $2) RETURNING id', [email, 'Test User']);
  const userId = u.rows[0].id as string;
  const scopes = opts.scopes ?? ['read', 'write', 'approve'];
  await owner.query('INSERT INTO membership (user_id, company_id, scopes) VALUES ($1, $2, $3)', [userId, companyId, scopes]);
  return { companyId, userId, email };
}
