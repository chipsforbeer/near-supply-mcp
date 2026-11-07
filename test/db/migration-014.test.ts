import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { migrate, MIGRATIONS_DIR } from '../../src/db/migrate.ts';
import { resetTestDatabase, roleUrl } from '../helpers/db.ts';

// Builds a database up to migration 013 with a session from before 014, then applies 014.
const DB = 'sim_test_m014';

async function asSuperuser(db: string, sql: string): Promise<void> {
  const c = new pg.Client({ connectionString: roleUrl('postgres', db) });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

let dir: string;
before(async () => {
  await resetTestDatabase(); // makes sure the roles exist
  await asSuperuser('postgres', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await asSuperuser('postgres', `CREATE DATABASE ${DB} OWNER sim_owner`);
  await asSuperuser(DB, 'GRANT USAGE ON SCHEMA public TO sim_app, sim_read; REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  dir = await mkdtemp(path.join(tmpdir(), 'sim-m014-'));
  for (const f of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql') && f < '014')) {
    await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  }
  await migrate(roleUrl('sim_owner', DB), dir);
});

after(() => asSuperuser('postgres', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`));

test('014 ends sessions that do not know their key and gives every session an end', async () => {
  const owner = new pg.Client({ connectionString: roleUrl('sim_owner', DB) });
  await owner.connect();
  try {
    const company = (await owner.query(`INSERT INTO company (name, slug) VALUES ('Old Co', 'old-co') RETURNING id`)).rows[0].id;
    const user = (await owner.query(`INSERT INTO app_user (email, display_name) VALUES ('old@example.test', 'Old') RETURNING id`)).rows[0].id;
    await owner.query(`INSERT INTO oauth_client (client_id, redirect_uris, metadata) VALUES ('c1', '{http://127.0.0.1:1/cb}', '{}')`);
    const session = async (revoked: boolean) =>
      (await owner.query(
        `INSERT INTO oauth_session (user_id, company_id, client_id, scopes, resource, access_hmac, access_expires_at, refresh_hmac, revoked_at, created_at)
         VALUES ($1, $2, 'c1', '{read}', 'r', md5(random()::text), now(), md5(random()::text), $3, now() - interval '2 days') RETURNING id`,
        [user, company, revoked ? new Date('2026-10-01T00:00:00Z') : null],
      )).rows[0].id;
    const live = await session(false);
    const ended = await session(true);

    await copyFile(path.join(MIGRATIONS_DIR, '014_session_audit.sql'), path.join(dir, '014_session_audit.sql'));
    assert.deepEqual(await migrate(roleUrl('sim_owner', DB), dir), ['014_session_audit.sql']);

    const rows = (await owner.query(
      `SELECT id, revoked_at, expires_at - created_at AS life FROM oauth_session ORDER BY created_at, id`,
    )).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.ok(byId.get(live).revoked_at, 'the live legacy session is ended');
    assert.equal(new Date(byId.get(ended).revoked_at).toISOString(), '2026-10-01T00:00:00.000Z', 'an ended session keeps its time');
    for (const r of rows) assert.equal(r.life.days, 30);
    // The new event kind is accepted.
    await owner.query(`INSERT INTO auth_event (kind, api_key_id) VALUES ('key_revoked', NULL)`);
  } finally {
    await owner.end();
  }
});
