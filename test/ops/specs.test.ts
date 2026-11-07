import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase, testDb } from '../helpers/db.ts';
import { newActor, call, type Actor } from '../helpers/ops.ts';
import { setupSite, makeItem } from '../helpers/fixtures.ts';
import { OpError } from '../../src/ops/errors.ts';
import { withCompany } from '../../src/db/pool.ts';

before(resetTestDatabase);
const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;

async function sheetWithSpec(a: Actor) {
  await setupSite(a);
  const sheet = await makeItem(a, { sku: 'SS304', name: '304 sheet 1.5 mm', base_uom: 'kg', physical_form: 'sheet', is_lot_tracked: true });
  await call(a, 'spec_upsert', { item_id: sheet.id, body_md: '304, 1.5 mm +/- 0.10, 2B finish' });
  const v2 = await call(a, 'spec_upsert', { item_id: sheet.id, body_md: '304, 1.5 mm +/- 0.08, 2B finish, EN 10204 3.1 mill cert' });
  return { sheet, v2 };
}

test('a new active spec supersedes the old one and RFQs pin the active version', async () => {
  const a = await newActor();
  const { sheet, v2 } = await sheetWithSpec(a);
  assert.equal(v2.version, 2);
  const active = await call(a, 'spec_get', { item_id: sheet.id });
  assert.equal(active.version, 2);
  assert.match(active.body_md, /3\.1 mill cert/);
  assert.equal((await call(a, 'spec_get', { item_id: sheet.id, version: 1 })).status, 'superseded');
  const rfq = await call(a, 'rfq_create', { site_code: 'MAIN', trigger: 'manual', lines: [{ item_id: sheet.id, qty: 708 }] });
  assert.equal(rfq.lines[0].spec_id, v2.spec_id);
});

test('not_good on a delivered lot quarantines it', async () => {
  const a = await newActor();
  const { sheet } = await sheetWithSpec(a);
  await call(a, 'stock_move', { item_id: sheet.id, type: 'receipt', qty: 708, site_code: 'MAIN', location_code: 'A-01', lot_code: 'HEAT-77' });
  const levels = await call(a, 'stock_levels', { item_id: sheet.id });
  const lotId = (await withCompany(testDb().app, a.session.companyId, (tx) => tx.query(`SELECT id FROM lot WHERE lot_code = 'HEAT-77'`))).rows[0].id;
  assert.equal(levels.items[0].usable, true);
  const e = await call(a, 'evaluation_log', {
    subject_type: 'lot', subject_id: lotId, verdict: 'not_good',
    reasoning: 'Mill cert shows 1.38 mm average thickness, outside 1.5 +/- 0.08.',
  });
  assert.deepEqual(e.effects, ['lot quarantined']);
  assert.equal(e.spec_version, 2);
  const after = await call(a, 'stock_levels', { item_id: sheet.id });
  assert.equal(after.items[0].lot_status, 'quarantine');
  assert.equal(after.items[0].usable, false);
});

test('verdicts sort quotes into offers, incomplete and rejected', async () => {
  const a = await newActor();
  const { sheet } = await sheetWithSpec(a);
  const names = ['Example Steel C', 'Example Steel D', 'Example Steel E'];
  const suppliers = [];
  for (const name of names) suppliers.push((await call(a, 'supplier_upsert', { name, origin: 'existing', allow_similar: true })).supplier);
  const rfq = await call(a, 'rfq_create', { site_code: 'MAIN', trigger: 'manual', lines: [{ item_id: sheet.id, qty: 708 }] });
  await call(a, 'rfq_add_recipients', { rfq_id: rfq.rfq_id, recipients: suppliers.map((s) => ({ supplier_id: s.id })) });
  const lineIds: string[] = [];
  for (const [i, s] of suppliers.entries()) {
    const q = await call(a, 'quote_record', {
      rfq_id: rfq.rfq_id, supplier_id: s.id, received_at: '2026-11-04T08:00:00Z', currency: 'USD',
      lines: [{ rfq_line_id: rfq.lines[0].id, item_id: sheet.id, pack_qty: 1, pack_uom: 'kg', price_per_pack: String(3 + i / 10) }],
    });
    lineIds.push(q.lines[0].quote_line_id);
  }
  await call(a, 'evaluation_log', { subject_type: 'quote_line', subject_id: lineIds[0], verdict: 'good', reasoning: 'Dual-certified 304/304L meets 304; 1.5 mm, 2B, 3.1 cert.' });
  await call(a, 'evaluation_log', { subject_type: 'quote_line', subject_id: lineIds[1], verdict: 'not_good', reasoning: '1.4 mm offered, outside 1.5 +/- 0.08.' });
  await call(a, 'evaluation_log', { subject_type: 'quote_line', subject_id: lineIds[2], verdict: 'needs_info', reasoning: 'No mill certificate offered; asked for 3.1.' });
  const cmp = await call(a, 'quote_compare', { rfq_id: rfq.rfq_id });
  const line = cmp.lines[0];
  assert.deepEqual(line.offers.map((o: any) => o.supplier), ['Example Steel C']);
  assert.deepEqual(line.rejected.map((o: any) => o.supplier), ['Example Steel D']);
  assert.deepEqual(line.incomplete.map((o: any) => o.supplier), ['Example Steel E']);
  const status = await call(a, 'outreach_status', { rfq_id: rfq.rfq_id });
  assert.equal(status.recipients.find((r: any) => r.supplier === 'Example Steel D').status, 'disqualified');
  const list = await call(a, 'evaluation_list', { verdict: 'not_good' });
  assert.equal(list.items.length, 1);
});

test('evaluations need real reasoning and are append-only', async () => {
  const a = await newActor();
  const { supplier } = await call(a, 'supplier_upsert', { name: 'Short Reason Co', origin: 'existing' });
  await assert.rejects(call(a, 'evaluation_log', { subject_type: 'supplier', subject_id: supplier.id, verdict: 'good', reasoning: 'ok' }), isCode('invalid_arguments'));
  await call(a, 'evaluation_log', { subject_type: 'supplier', subject_id: supplier.id, verdict: 'good', reasoning: 'ISO 9001 certificate valid to 2028.' });
  await assert.rejects(withCompany(testDb().app, a.session.companyId, (tx) => tx.query(`UPDATE evaluation SET verdict = 'not_good'`)), /permission denied/);
  await assert.rejects(call(a, 'evaluation_log', { subject_type: 'lot', subject_id: supplier.id, verdict: 'good', reasoning: 'wrong subject type here' }), isCode('not_found'));
});
