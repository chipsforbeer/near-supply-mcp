import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resetTestDatabase, testDb, testConfig, testOwnerPool } from '../helpers/db.ts';
import { seedDemo, type SeededCompany } from '../../src/seed/demo.ts';
import { runOperation } from '../../src/ops/run.ts';
import { ops } from '../../src/ops/catalogue.ts';
import { OpError } from '../../src/ops/errors.ts';
import { startToolAudit } from '../../src/audit/audit.ts';
import { READABLE_TABLES } from '../../src/sql/allowlist.ts';
import type { OpContext } from '../../src/ops/types.ts';

let A: SeededCompany;
let B: SeededCompany;
const ids: Record<string, string> = {};

async function ctxFor(companyId: string): Promise<OpContext> {
  const r = await testOwnerPool().query(`SELECT user_id FROM membership WHERE company_id = $1 AND 'approve' = ANY (scopes)`, [companyId]);
  const session = { userId: r.rows[0].user_id as string, companyId, sessionId: randomUUID(), scopes: ['read', 'write', 'approve'] as ('read' | 'write' | 'approve')[], client: 'test' as const };
  return { db: testDb(), cfg: testConfig(), session, toolAuditId: await startToolAudit(testDb(), session, 'test', 'cross-company check', null) };
}

// biome-ignore lint: loosely typed on purpose.
async function as(companyId: string, op: string, args: Record<string, unknown>, key = `k-${randomUUID()}`): Promise<any> {
  return runOperation(op, { request_key: key, reason: 'cross-company check', ...args }, await ctxFor(companyId), { autoStripForReads: true });
}

async function snapshotA(): Promise<string> {
  const client = await testOwnerPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.company_id', $1, true)`, [A.id]);
    const parts: unknown[] = [];
    for (const t of [...READABLE_TABLES].filter((x) => !['uom', 'container_type', 'contact_method_type'].includes(x)).sort()) {
      // Filtered explicitly: the owner is not held to row-level security on change_log.
      parts.push([t, (await client.query(`SELECT count(*)::int AS n FROM ${t} WHERE company_id = $1`, [A.id])).rows[0].n]);
    }
    parts.push((await client.query('SELECT lot_code, status FROM lot ORDER BY lot_code')).rows);
    parts.push((await client.query('SELECT po_code, status, payment_status FROM purchase_order ORDER BY po_code')).rows);
    parts.push((await client.query('SELECT name, notes FROM supplier ORDER BY name')).rows);
    parts.push((await client.query('SELECT count(*)::int AS n FROM supplier_payout_account')).rows);
    parts.push((await client.query('SELECT path, revision, status FROM wiki_page ORDER BY path, revision')).rows);
    await client.query('COMMIT');
    return JSON.stringify(parts);
  } finally {
    client.release();
  }
}

before(async () => {
  await resetTestDatabase();
  [A, B] = (await seedDemo({ db: testDb(), cfg: testConfig() }, testOwnerPool())) as [SeededCompany, SeededCompany];
  const sheet = (await as(A.id, 'item_get', { sku: 'SS304-1.5' }));
  const enclosure = (await as(A.id, 'item_get', { sku: 'ENC-400' }));
  const supplier = (await as(A.id, 'supplier_search', { query: 'Stainless' })).items[0];
  const sup = await as(A.id, 'supplier_get', { supplier_id: supplier.id });
  const rfq = await as(A.id, 'rfq_create', { site_code: 'MAIN', trigger: 'manual', lines: [{ item_id: sheet.id, qty: 708 }] }, 'a-known-key-0001');
  await as(A.id, 'rfq_add_recipients', { rfq_id: rfq.rfq_id, recipients: [{ supplier_id: supplier.id }] });
  const doc = await as(A.id, 'document_capture_text', { title: 'Northbeck private note', kind: 'note', text: 'Private negotiation notes for stainless.', source: 'note' });
  const inter = await as(A.id, 'interaction_log', { supplier_id: supplier.id, rfq_id: rfq.rfq_id, direction: 'out', channel: 'email', summary: 'RFQ sent.', occurred_at: new Date().toISOString() });
  const quote = await as(A.id, 'quote_record', { rfq_id: rfq.rfq_id, supplier_id: supplier.id, received_at: new Date().toISOString(), currency: 'USD',
    lines: [{ rfq_line_id: rfq.lines[0].id, item_id: sheet.id, pack_qty: 1, pack_uom: 'kg', price_per_pack: '3.0' }] });
  const ev = await as(A.id, 'evaluation_log', { subject_type: 'quote_line', subject_id: quote.lines[0].quote_line_id, verdict: 'good', reasoning: 'Meets the sheet spec in full.' });
  const po = await as(A.id, 'po_create', { supplier_id: supplier.id, site_code: 'MAIN', currency: 'USD', lines: [{ item_id: sheet.id, qty: 708, price_per_base: '3' }] });
  const lot = await as(A.id, 'sql_query', { sql: `SELECT id FROM lot WHERE lot_code = 'HEAT-1001'` });
  const txn = await as(A.id, 'sql_query', { sql: `SELECT id FROM stock_txn ORDER BY id LIMIT 1` });
  Object.assign(ids, {
    sheet: sheet.id, enclosure: enclosure.id, supplier: supplier.id, contact: sup.contacts[0].id, rfq: rfq.rfq_id, rfq_line: rfq.lines[0].id,
    doc: doc.document_id, interaction: inter.interaction_id, quote: quote.quote_id, quote_line: quote.lines[0].quote_line_id,
    evaluation: ev.evaluation_id, po: po.po_id, po_line: po.lines[0].po_line_id, lot: lot.rows[0][0], txn: String(txn.rows[0][0]),
  });
});

// For every operation: how company B calls it, using company A's ids wherever it takes one.
// deny: must be refused. clean: may succeed, but must show nothing of company A.
type Case = [Record<string, unknown>, 'deny' | 'clean'];
const A_PAGE = 'suppliers/example-stainless-stockholders.md';
const now = () => new Date().toISOString();
const CASES = (): Record<string, Case> => ({
  whoami: [{}, 'clean'],
  operation_status: [{ request_key: 'a-known-key-0001' }, 'deny'],
  audit_list: [{ limit: 200 }, 'clean'],
  company_rules_get: [{}, 'clean'],
  users_list: [{}, 'clean'],
  change_history: [{ limit: 500 }, 'clean'],
  auth_events_list: [{ limit: 500 }, 'clean'],
  guide_list: [{}, 'clean'],
  guide_get: [{ module: 'buying' }, 'clean'],
  wiki_list: [{ recursive: true, include_deleted: true }, 'clean'],
  wiki_read: [{ path: A_PAGE }, 'deny'],
  wiki_search: [{ query: 'Stainless' }, 'clean'],
  wiki_history: [{ path: A_PAGE }, 'deny'],
  wiki_create: [{ path: 'notes/b-page.md', body_md: '# B page' }, 'clean'],
  wiki_write: [{ path: A_PAGE, body_md: 'x', expected_revision: 1 }, 'deny'],
  wiki_append: [{ path: A_PAGE, text: 'hijacked' }, 'deny'],
  wiki_replace: [{ path: A_PAGE, old_text: 'Summary', new_text: 'x' }, 'deny'],
  wiki_move: [{ path: A_PAGE, new_path: 'notes/moved.md' }, 'deny'],
  wiki_delete: [{ path: A_PAGE, expected_revision: 1 }, 'deny'],
  wiki_restore: [{ path: A_PAGE }, 'deny'],
  wiki_log_append: [{ action: 'note', summary: 'B note' }, 'clean'],
  item_upsert: [{ sku: 'B-NEW-1', name: 'B item', category: 'other', physical_form: 'discrete', sourcing_type: 'catalog', base_uom: 'each' }, 'clean'],
  item_get: [{ item_id: ids.sheet }, 'deny'],
  item_search: [{ query: 'stainless' }, 'clean'],
  item_identifier_add: [{ item_id: ids.sheet, kind: 'alias', value: 'x' }, 'deny'],
  item_pack_upsert: [{ item_id: ids.sheet, name: 'x', contains_qty: 1 }, 'deny'],
  item_conversion_set: [{ item_id: ids.sheet, from_uom: 'L', to_uom: 'kg', factor: 1 }, 'deny'],
  location_upsert: [{ site_code: 'MAIN', code: 'X-1', name: 'x', kind: 'rack' }, 'deny'],
  container_type_list: [{}, 'clean'],
  stock_move: [{ item_id: ids.sheet, type: 'issue', qty: 1, site_code: 'MAIN', location_code: 'A-01', lot_code: 'HEAT-1001' }, 'deny'],
  stock_count: [{ item_id: ids.sheet, site_code: 'MAIN', location_code: 'A-01', lot_code: 'HEAT-1001', counted_qty: 0 }, 'deny'],
  stock_levels: [{ item_id: ids.sheet }, 'clean'],
  stock_history: [{ item_id: ids.sheet }, 'deny'],
  stock_reverse: [{ txn_id: ids.txn, note: 'x' }, 'deny'],
  lot_status_set: [{ lot_id: ids.lot, status: 'rejected', note: 'cross company' }, 'deny'],
  bom_upsert: [{ output_item_id: ids.enclosure, batch_qty: 1, lines: [{ item_id: ids.sheet, qty: 1 }] }, 'deny'],
  bom_get: [{ output_item_id: ids.enclosure }, 'deny'],
  production_run_record: [{ output_item_id: ids.enclosure, run_code: 'X-1', site_code: 'MAIN', consume_location_code: 'A-01', output_location_code: 'FG', actual_output_qty: 1 }, 'deny'],
  supplier_upsert: [{ supplier_id: ids.supplier, notes: 'hijacked' }, 'deny'],
  supplier_get: [{ supplier_id: ids.supplier }, 'deny'],
  supplier_search: [{ query: 'Stainless' }, 'clean'],
  supplier_find_duplicates: [{ name: 'Example Stainless Stockholders', website: 'https://stainless-stock.example.com', email: 'sales@stainless-stock.example.com' }, 'clean'],
  supplier_import: [{ suppliers: [{ name: 'B Import Co' }] }, 'clean'],
  contact_upsert: [{ supplier_id: ids.supplier, full_name: 'x' }, 'deny'],
  contact_method_update: [{ supplier_id: ids.supplier, contact_method_id: ids.contact, value: 'x@b.example.test' }, 'deny'],
  contact_method_add: [{ supplier_id: ids.supplier, contact_id: ids.contact, type: 'email', value: 'x@b.example.test' }, 'deny'],
  supplier_item_upsert: [{ supplier_id: ids.supplier, item_id: ids.sheet }, 'deny'],
  supplier_offering_upsert: [{ supplier_id: ids.supplier, kind: 'product', category: 'Copied range' }, 'deny'],
  supplier_payout_account_set: [{ supplier_id: ids.supplier, network: 'near', account_id: 'attacker.testnet', token: 'usdc', note: 'redirect payments' }, 'deny'],
  rfq_create: [{ site_code: 'MAIN', trigger: 'manual', lines: [{ item_id: ids.sheet, qty: 1 }] }, 'deny'],
  rfq_add_recipients: [{ rfq_id: ids.rfq, recipients: [{ supplier_id: ids.supplier }] }, 'deny'],
  rfq_get: [{ rfq_id: ids.rfq }, 'deny'],
  rfq_list: [{}, 'clean'],
  rfq_status_set: [{ rfq_id: ids.rfq, status: 'cancelled', note: 'cross company' }, 'deny'],
  interaction_log: [{ supplier_id: ids.supplier, direction: 'in', channel: 'email', summary: 'x', occurred_at: now() }, 'deny'],
  outreach_status: [{ rfq_id: ids.rfq }, 'deny'],
  quote_record: [{ supplier_id: ids.supplier, received_at: now(), currency: 'USD', lines: [{ item_id: ids.sheet, pack_qty: 1, price_per_pack: 1 }] }, 'deny'],
  fx_rate_record: [{ from_currency: 'EUR', to_currency: 'USD', rate: '1.1', as_of: '2026-11-01', source: 'B test rate' }, 'clean'],
  quote_compare: [{ rfq_id: ids.rfq }, 'deny'],
  spec_upsert: [{ item_id: ids.sheet, body_md: 'x' }, 'deny'],
  spec_get: [{ item_id: ids.sheet }, 'deny'],
  evaluation_log: [{ subject_type: 'quote_line', subject_id: ids.quote_line, verdict: 'not_good', reasoning: 'cross company attempt' }, 'deny'],
  evaluation_list: [{ subject_id: ids.quote_line }, 'clean'],
  po_create: [{ supplier_id: ids.supplier, site_code: 'MAIN', currency: 'USD', lines: [{ item_id: ids.sheet, qty: 1, price_per_base: 1 }] }, 'deny'],
  po_approve: [{ po_id: ids.po, approved_max_amount: '999999' }, 'deny'],
  po_payment_instruction: [{ po_id: ids.po }, 'deny'],
  po_payment_record: [{ po_id: ids.po, network: 'near', payment_ref: 'fake-ref-0001', outcome: 'paid' }, 'deny'],
  po_receive: [{ po_id: ids.po, location_code: 'A-01', lines: [{ po_line_id: ids.po_line, qty: 1, lot_code: 'X' }] }, 'deny'],
  po_get: [{ po_id: ids.po }, 'deny'],
  po_status_set: [{ po_id: ids.po, status: 'cancelled', note: 'cross company' }, 'deny'],
  reorder_policy_set: [{ item_id: ids.sheet, site_code: 'MAIN', method: 'manual' }, 'deny'],
  low_stock_report: [{ include_ok: true }, 'clean'],
  document_get: [{ document_id: ids.doc }, 'deny'],
  document_link: [{ document_id: ids.doc, entity_type: 'supplier', entity_id: ids.supplier }, 'deny'],
  document_search: [{ query: 'negotiation' }, 'clean'],
  documents_expiring: [{ within_days: 365 }, 'clean'],
  document_capture_text: [{ title: 'b', kind: 'note', text: 'b text', source: 'note', links: [{ entity_type: 'item', entity_id: ids.sheet }] }, 'deny'],
  document_add: [{ title: 'x', kind: 'other', location: 'C:\\b\\x.pdf', links: [{ entity_type: 'supplier', entity_id: ids.supplier }] }, 'deny'],
  document_update: [{ document_id: ids.doc, location: 'C:\\b\\moved.pdf' }, 'deny'],
  sql_query: [{ sql: 'SELECT id, sku, name FROM item' }, 'clean'],
});

test('every operation refuses or hides company A data from company B', async () => {
  const cases = CASES();
  const missing = [...ops.values()].filter((d) => !d.hidden).map((d) => d.name).filter((n) => !(n in cases));
  assert.deepEqual(missing, [], 'add new operations to CASES');
  // Stock transaction ids are small shared sequence numbers, so they cannot serve as text markers.
  const markers = [...Object.entries(ids).filter(([k]) => k !== 'txn').map(([, v]) => v), 'Example Stainless Stockholders', 'SS304-1.5', 'Northbeck', 'negotiation', A_PAGE, 'EN 10204 3.1', 'northbeck-metalworks', 'Stainless sheet and plate', 'EX-VAT-1001', A.id];
  // The same id values, swapped for ones that exist nowhere: a refusal must read the same either way.
  const fake = new Map(Object.entries(ids).map(([k, v]) => [v, k === 'txn' ? '999999999' : randomUUID()]));
  const swap = (v: unknown): unknown =>
    typeof v === 'string' ? (fake.get(v) ?? v) : Array.isArray(v) ? v.map(swap) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v;
  const unswap = (s: string) => [...fake].reduce((acc, [real, f]) => acc.split(f).join(real), s);
  const before = await snapshotA();
  for (const [op, [args, mode]] of Object.entries(cases)) {
    // Only what B did not pass in itself counts as a leak.
    const unseen = markers.filter((m) => !JSON.stringify(args).includes(m));
    let out: unknown;
    try {
      out = await as(B.id, op, args);
    } catch (e) {
      assert.ok(e instanceof OpError, `${op}: unexpected ${String(e)}`);
      assert.notEqual(e.code, 'internal', `${op}: internal error`);
      assert.ok(!unseen.some((m) => e.message.includes(m)), `${op}: error message leaks company A data`);
      const other = await as(B.id, op, swap(args) as Record<string, unknown>).then(() => null, (x: unknown) => x);
      assert.ok(other instanceof OpError, `${op}: a made-up id was accepted where company A's was refused`);
      assert.deepEqual([other.code, unswap(other.message)], [e.code, e.message], `${op}: refusal tells A's ids apart from made-up ones`);
      continue;
    }
    assert.notEqual(mode, 'deny', `${op}: company B was allowed to use company A ids`);
    const text = JSON.stringify(out);
    for (const m of unseen) assert.ok(!text.includes(m), `${op}: result leaks ${m}`);
  }
  assert.equal(await snapshotA(), before, 'company A data changed');
});

test('raw SQL over every readable table returns only company B rows', async () => {
  for (const t of [...READABLE_TABLES].filter((x) => !['uom', 'container_type', 'contact_method_type'].includes(x))) {
    const r = await as(B.id, 'sql_query', { sql: `SELECT DISTINCT company_id FROM ${t}`, max_rows: 1000 });
    for (const row of r.rows) assert.equal(row[0], B.id, t);
  }
});
