import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { migrate, MIGRATIONS_DIR } from '../../src/db/migrate.ts';
import { resetTestDatabase, roleUrl } from '../helpers/db.ts';

// Builds a database up to migration 012, fills the old slug-based wiki, then applies 013.
const DB = 'sim_test_m013';

async function asSuperuser(sql: string): Promise<void> {
  const c = new pg.Client({ connectionString: roleUrl('postgres', 'postgres') });
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
  await asSuperuser(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await asSuperuser(`CREATE DATABASE ${DB} OWNER sim_owner`);
  const c = new pg.Client({ connectionString: roleUrl('postgres', DB) });
  await c.connect();
  await c.query('GRANT USAGE ON SCHEMA public TO sim_app, sim_read');
  await c.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await c.end();
  dir = await mkdtemp(path.join(tmpdir(), 'sim-m013-'));
  for (const f of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql') && f < '013')) {
    await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  }
  await migrate(roleUrl('sim_owner', DB), dir);
});

after(() => asSuperuser(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`));

test('013 turns slug pages into .md paths and the log table into log.md', async () => {
  const owner = new pg.Client({ connectionString: roleUrl('sim_owner', DB) });
  await owner.connect();
  try {
    const company = (await owner.query(`INSERT INTO company (name, slug) VALUES ('Old Co', 'old-co') RETURNING id`)).rows[0].id;
    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('app.company_id', $1, true)`, [company]);
    const page = async (slug: string, type: string, body: string, status = 'active', revision = 1) =>
      (await owner.query(
        `INSERT INTO wiki_page (slug, title, page_type, body_md, status, revision) VALUES ($1, $1, $2, $3, $4, $5) RETURNING id`,
        [slug, type, body, status, revision],
      )).rows[0].id;
    const index = await page('index', 'index', '# Index');
    const acme = await page('supplier-acme', 'supplier', '# Acme\n\nSee [[index]].', 'active', 2);
    await page('old-notes', 'topic', 'old', 'archived');
    for (const [id, rev, note] of [[index, 1, 'starter page'], [acme, 1, 'first'], [acme, 2, 'quoted']] as const) {
      await owner.query(
        `INSERT INTO wiki_revision (page_id, revision, title, body_md, edit_summary, via_agent) VALUES ($1, $2, 't', 'b', $3, true)`,
        [id, rev, note],
      );
    }
    await owner.query(`INSERT INTO wiki_link (from_page_id, to_slug) VALUES ($1, 'index')`, [acme]);
    await owner.query(
      `INSERT INTO wiki_log (at, action, summary, via_agent) VALUES
         ('2026-10-01 09:05+00', 'note', 'first line', true), ('2026-10-02 10:30+00', 'decision', E'chose\nAcme', true)`,
    );
    await owner.query('COMMIT');

    await copyFile(path.join(MIGRATIONS_DIR, '013_wiki_files.sql'), path.join(dir, '013_wiki_files.sql'));
    assert.deepEqual(await migrate(roleUrl('sim_owner', DB), dir), ['013_wiki_files.sql']);

    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('app.company_id', $1, true)`, [company]);
    const pages = (await owner.query('SELECT path, status FROM wiki_page ORDER BY path')).rows.map((r) => [r.path, r.status]);
    assert.deepEqual(pages, [['index.md', 'active'], ['log.md', 'active'], ['old-notes.md', 'deleted'], ['supplier-acme.md', 'active']]);
    const revs = (await owner.query(
      `SELECT p.path, r.revision, r.action, r.reason FROM wiki_revision r JOIN wiki_page p ON p.id = r.page_id ORDER BY p.path, r.revision`,
    )).rows.map((r) => [r.path, r.revision, r.action, r.reason]);
    assert.deepEqual(revs, [
      ['index.md', 1, 'create', 'starter page'],
      ['log.md', 1, 'create', 'converted from the activity log table'],
      ['supplier-acme.md', 1, 'create', 'first'],
      ['supplier-acme.md', 2, 'edit', 'quoted'],
    ]);
    assert.deepEqual((await owner.query('SELECT to_path FROM wiki_link')).rows, [{ to_path: 'index.md' }]);
    const log = (await owner.query(`SELECT body_md FROM wiki_page WHERE path = 'log.md'`)).rows[0].body_md;
    assert.match(log, /\n- 2026-10-01 09:05 UTC \| note \| first line\n- 2026-10-02 10:30 UTC \| decision \| chose Acme\n$/);
    await owner.query('COMMIT');

    const gone = await owner.query(`SELECT to_regclass('wiki_log') AS t`);
    assert.equal(gone.rows[0].t, null);
    const forced = await owner.query(
      `SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('wiki_page', 'wiki_revision', 'wiki_link') ORDER BY relname`,
    );
    assert.deepEqual(forced.rows.map((r) => r.relforcerowsecurity), [true, true, true]);
  } finally {
    await owner.end();
  }
});
