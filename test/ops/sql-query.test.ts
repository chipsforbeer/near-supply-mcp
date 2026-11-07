import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase } from '../helpers/db.ts';
import { newActor, call } from '../helpers/ops.ts';
import { makeItem } from '../helpers/fixtures.ts';
import { OpError } from '../../src/ops/errors.ts';

before(resetTestDatabase);
const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;

test('each company sees only its own rows, even with SELECT *', async () => {
  const a = await newActor();
  const b = await newActor();
  await makeItem(a, { sku: 'A-ONLY', name: 'Company A item' });
  await makeItem(b, { sku: 'B-ONLY', name: 'Company B item' });
  const ra = await call(a, 'sql_query', { sql: 'SELECT sku FROM item' });
  assert.deepEqual(ra.rows, [['A-ONLY']]);
  const rb = await call(b, 'sql_query', { sql: 'SELECT sku, company_id FROM item' });
  assert.deepEqual(rb.rows.map((r: unknown[]) => r[0]), ['B-ONLY']);
  assert.equal(rb.rows[0][1], b.session.companyId);
  const wiki = await call(a, 'sql_query', { sql: `SELECT path FROM wiki_page ORDER BY path` });
  assert.deepEqual(wiki.rows.map((r: unknown[]) => r[0]), ['current-status.md', 'index.md', 'log.md', 'rules.md']);
});

test('max_rows truncates and reports it', async () => {
  const a = await newActor();
  for (let i = 0; i < 5; i += 1) await makeItem(a, { sku: `S-${i}`, name: `Item ${i}` });
  const r = await call(a, 'sql_query', { sql: 'SELECT sku FROM item ORDER BY sku', max_rows: 3 });
  assert.deepEqual(r.rows, [['S-0'], ['S-1'], ['S-2']]);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.columns, ['sku']);
});

test('refused queries and unreadable columns give constant errors', async () => {
  const a = await newActor();
  await assert.rejects(call(a, 'sql_query', { sql: 'SELECT * FROM supplier_payout_account' }), isCode('invalid_arguments'));
  await assert.rejects(call(a, 'sql_query', { sql: 'SELECT search FROM wiki_page' }), isCode('forbidden'));
  await assert.rejects(call(a, 'sql_query', { sql: 'SELECT no_such_column FROM item' }), isCode('invalid_arguments'));
});
