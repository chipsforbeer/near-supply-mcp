import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase, testDb, testOwnerPool } from '../helpers/db.ts';
import { newActor, call } from '../helpers/ops.ts';
import { withCompany } from '../../src/db/pool.ts';

before(resetTestDatabase);

// Company tables the app can change that keep their own full history instead.
const OWN_HISTORY: Record<string, string> = {
  wiki_page: 'wiki_revision keeps every version',
  wiki_link: 'rebuilt from the page text',
  stock_balance: 'derived from the append-only stock_txn ledger',
  supplier_payout_account: 'every version is kept (superseded rows stay)',
  operation_journal: 'it is the audit trail',
  oauth_code: 'sign-in plumbing, logged in auth_event',
  oauth_session: 'sign-in plumbing, logged in auth_event',
};

test('a change records each changed field before and after, with the operation, person and reason', async () => {
  const a = await newActor();
  const id = (await call(a, 'supplier_upsert', {
    name: 'Example Audit Co', origin: 'existing', legal_name: 'Old Ltd', website: 'https://audit.example.com', notes: 'first note',
    reason: 'add the supplier',
  })).supplier.id;
  await call(a, 'supplier_upsert', { supplier_id: id, legal_name: 'New Ltd', website: null, notes: null, reason: 'they renamed and closed the site' });

  const h = await call(a, 'change_history', { table: 'supplier', row_id: id });
  assert.deepEqual(h.items.map((c: any) => c.action), ['update', 'insert']);
  const [upd, ins] = h.items;
  assert.deepEqual(upd.before, { legal_name: 'Old Ltd', website: 'https://audit.example.com', notes: 'first note' });
  assert.deepEqual(upd.after, { legal_name: 'New Ltd', website: null, notes: null });
  assert.deepEqual([upd.operation, upd.reason], ['supplier_upsert', 'they renamed and closed the site']);
  assert.match(upd.user_email, /@/);
  assert.equal(ins.before, null);
  assert.equal(ins.after.name, 'Example Audit Co');
  assert.equal(ins.reason, 'add the supplier');
  assert.ok(!('updated_at' in upd.after) && !('name_norm' in ins.after), 'no noise columns');
});

test('a deleted row is kept whole in the log', async () => {
  const a = await newActor();
  const id = (await call(a, 'supplier_upsert', {
    name: 'Example Moving Co', origin: 'existing', addresses: [{ kind: 'hq', lines: '1 Old Road', city: 'Example City' }],
  })).supplier.id;
  await call(a, 'supplier_upsert', { supplier_id: id, addresses: [{ kind: 'hq', lines: '2 New Road', city: 'Example City' }] });
  const h = await call(a, 'change_history', { table: 'supplier_address' });
  const del = h.items.find((c: any) => c.action === 'delete');
  assert.equal(del.before.lines, '1 Old Road');
  assert.equal(del.after, null);
  assert.ok(h.items.some((c: any) => c.action === 'insert' && c.after.lines === '2 New Road'));
});

test('every company table the app can change is logged, unless it keeps its own history', async () => {
  const r = await testOwnerPool().query(
    `SELECT c.relname AS t,
            EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'log_change') AS logged
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped)
        AND (has_table_privilege('sim_app', c.oid, 'UPDATE') OR has_table_privilege('sim_app', c.oid, 'DELETE')
             OR has_any_column_privilege('sim_app', c.oid, 'UPDATE'))
      ORDER BY 1`,
  );
  const missing = r.rows.filter((x) => !x.logged && !(x.t in OWN_HISTORY)).map((x) => x.t);
  assert.deepEqual(missing, [], 'add these tables to the change log, or to OWN_HISTORY with a reason');
  const needless = r.rows.filter((x) => x.logged && x.t in OWN_HISTORY).map((x) => x.t);
  assert.deepEqual(needless, []);
});

test('the log cannot be written or changed by the app, and another company sees none of it', async () => {
  const a = await newActor();
  const b = await newActor();
  await call(a, 'supplier_upsert', { name: 'Example Hidden Co', origin: 'existing', notes: 'private' });
  for (const sql of [`INSERT INTO change_log (table_name, action) VALUES ('x', 'insert')`, 'UPDATE change_log SET after = NULL', 'DELETE FROM change_log']) {
    await assert.rejects(withCompany(testDb().app, a.session.companyId, (tx) => tx.query(sql)), /permission denied/, sql);
  }
  const hb = await call(b, 'change_history', { table: 'supplier', limit: 500 });
  assert.ok(!JSON.stringify(hb).includes('Example Hidden Co'));
});
