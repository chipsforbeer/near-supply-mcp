import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase, testDb, createCompanyWithUser, roleUrl } from '../helpers/db.ts';
import { withCompany } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';

before(resetTestDatabase);

test('a company sees only its own brands', async () => {
  const db = testDb();
  const a = await createCompanyWithUser(db, {});
  const b = await createCompanyWithUser(db, {});
  await withCompany(db.app, a.companyId, (tx) => tx.query(`INSERT INTO brand (name) VALUES ('Alpha')`));
  const seenByB = await withCompany(db.app, b.companyId, (tx) => tx.query('SELECT * FROM brand'));
  assert.equal(seenByB.rowCount, 0);
  const seenByA = await withCompany(db.app, a.companyId, (tx) => tx.query('SELECT name FROM brand'));
  assert.deepEqual(seenByA.rows.map((r) => r.name), ['Alpha']);
});

test('a company cannot insert rows for another company', async () => {
  const db = testDb();
  const a = await createCompanyWithUser(db, {});
  const b = await createCompanyWithUser(db, {});
  await assert.rejects(
    withCompany(db.app, a.companyId, (tx) => tx.query('INSERT INTO brand (company_id, name) VALUES ($1, $2)', [b.companyId, 'Sneaky'])),
    /row-level security/,
  );
});

test('without a company context nothing is visible or insertable', async () => {
  const db = testDb();
  const client = await db.app.connect();
  try {
    const r = await client.query('SELECT * FROM brand');
    assert.equal(r.rowCount, 0);
    await assert.rejects(client.query(`INSERT INTO brand (name) VALUES ('X')`));
  } finally {
    client.release();
  }
});

test('sim_read cannot read auth tables', async () => {
  const db = testDb();
  await assert.rejects(db.read.query('SELECT * FROM api_key'), /permission denied/);
});

test('migrations are idempotent', async () => {
  const applied = await migrate(roleUrl('sim_owner'));
  assert.deepEqual(applied, []);
});
