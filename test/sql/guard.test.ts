import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSelect } from '../../src/sql/guard.ts';
import { READABLE_TABLES } from '../../src/sql/allowlist.ts';
import { OpError } from '../../src/ops/errors.ts';

const opts = { maxRows: 100, tables: READABLE_TABLES };
const ok = (sql: string) => validateSelect(sql, opts);
const bad = (sql: string, pattern?: RegExp) =>
  assert.rejects(ok(sql), (e: unknown) => e instanceof OpError && e.code === 'invalid_arguments' && (!pattern || pattern.test(e.message)));

test('accepted: joins, CTEs, window functions, aggregates, casts, subqueries', async () => {
  for (const sql of [
    `SELECT i.sku, sum(b.qty_base) FROM item i JOIN stock_balance b ON b.item_id = i.id GROUP BY i.sku`,
    `WITH low AS (SELECT item_id FROM stock_balance WHERE qty_base < 10) SELECT * FROM low`,
    `SELECT sku, row_number() OVER (ORDER BY name) FROM item`,
    `SELECT count(*) FROM supplier WHERE status IN ('approved','preferred') AND created_at > now() - make_interval(days => 30)`,
    `SELECT qty_base::numeric(20,2), occurred_at::date FROM stock_txn WHERE item_id IN (SELECT id FROM item WHERE category = 'chemical')`,
    `SELECT name FROM supplier UNION SELECT name FROM brand`,
    `SELECT CASE WHEN status = 'active' THEN 1 ELSE 0 END, coalesce(hazmat_class, '-') FROM item`,
  ]) {
    const out = await ok(sql);
    assert.match(out, /LIMIT 101/, sql);
  }
});

test('LIMIT is capped and smaller limits kept', async () => {
  assert.match(await ok('SELECT sku FROM item LIMIT 5'), /LIMIT 5\b/);
  assert.match(await ok('SELECT sku FROM item LIMIT 5000'), /LIMIT 101\b/);
});

test('rejected: writes, multiple statements, comments, settings and system access', async () => {
  await bad(`INSERT INTO item (sku) VALUES ('x')`, /Only SELECT/);
  await bad(`UPDATE item SET name = 'x'`);
  await bad(`DELETE FROM stock_txn`);
  await bad(`SELECT 1; SELECT 2`, /Exactly one/);
  await bad(`SELECT 1 -- hi`, /comments/);
  await bad(`SELECT /* x */ 1`, /comments/);
  await bad(`SELECT set_config('app.company_id', '00000000-0000-0000-0000-000000000000', true)`, /set_config/);
  await bad(`SELECT current_setting('app.company_id')`, /current_setting/);
  await bad(`SELECT * FROM pg_catalog.pg_class`, /tables of this database/);
  await bad(`SELECT * FROM pg_class`, /not readable/);
  await bad(`SELECT * FROM api_key`, /not readable/);
  await bad(`SELECT * FROM company`, /not readable/);
  await bad(`SELECT * FROM supplier_payout_account`, /not readable/);
  await bad(`SELECT * FROM operation_journal`, /not readable/);
  await bad(`SELECT pg_read_file('/etc/passwd')`, /not allowed/);
  await bad(`SELECT pg_catalog.now()`, /not allowed/);
  await bad(`SELECT * FROM item FOR UPDATE`, /Locking/);
  await bad(`WITH RECURSIVE r AS (SELECT 1 UNION SELECT 1 FROM r) SELECT * FROM r`, /Recursive/);
  await bad(`SELECT * INTO new_table FROM item`, /SELECT INTO/);
  await bad(`SELECT 'item'::regclass`, /Casting/);
  await bad(`SELECT * FROM generate_series(1, 10)`);
  await bad(`SELECT $1`);
  await bad(`SELECT sku FROM item LIMIT (SELECT 1)`, /LIMIT/);
});

test('a CTE name only shadows inside its own query', async () => {
  await ok(`WITH api_key AS (SELECT 1 AS x) SELECT * FROM api_key`);
  await bad(`SELECT * FROM api_key, (WITH api_key AS (SELECT 1 AS x) SELECT * FROM api_key) s`, /not readable/);
});

test('size and complexity limits', async () => {
  await bad(`SELECT ${'1,'.repeat(9000)}1`, /16 KB/);
  const joins = Array.from({ length: 13 }, (_, i) => `JOIN item i${i} ON i${i}.id = i.id`).join(' ');
  await bad(`SELECT 1 FROM item i ${joins}`, /joins/);
});
