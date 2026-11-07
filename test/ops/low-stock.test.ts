import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase } from '../helpers/db.ts';
import { newActor, call, type Actor } from '../helpers/ops.ts';
import { setupSite, makeItem } from '../helpers/fixtures.ts';
import { reorderDecision } from '../../src/ops/inventory/low-stock-report.ts';

before(resetTestDatabase);

const malt = { method: 'days_of_cover' as const, on_order: '0', daily_usage: '60', lead_time: 10, safety_days: '5', target_cover_days: '30', min_qty: null, max_qty: null, pack_base: '25', moq_base: '1000' };

test('the worked example: 850 kg on hand, 60 kg/day, lead 10 + safety 5 -> reorder 1000 kg', () => {
  assert.deepEqual(reorderDecision({ ...malt, on_hand: '850' }), { status: 'reorder', reorder_at: '900', target: '1800', suggest: '1000' });
  assert.equal(reorderDecision({ ...malt, on_hand: '299' }).status, 'critical');
  assert.equal(reorderDecision({ ...malt, on_hand: '901' }).status, 'ok');
  assert.equal(reorderDecision({ ...malt, on_hand: '850', on_order: '1000' }).status, 'ok');
  assert.equal(reorderDecision({ ...malt, on_hand: '850', lead_time: null }).status, 'needs_lead_time');
  assert.equal(reorderDecision({ ...malt, on_hand: '850', daily_usage: '0' }).status, 'needs_usage_history');
});

test('suggestions round up to whole packs and the MOQ', () => {
  const r = reorderDecision({ ...malt, on_hand: '850', moq_base: null });
  assert.equal(r.suggest, '950');
  const bigger = reorderDecision({ ...malt, on_hand: '840', moq_base: null });
  assert.equal(bigger.suggest, '975');
  const minmax = reorderDecision({ method: 'min_max', on_hand: '3', on_order: '0', daily_usage: '0', lead_time: null, safety_days: null, target_cover_days: null, min_qty: '10', max_qty: '30', pack_base: '4', moq_base: null });
  assert.deepEqual([minmax.status, minmax.suggest], ['critical', '28']);
});

async function maltPlant(a: Actor) {
  await setupSite(a);
  const item = await makeItem(a, { sku: 'MALT', name: 'Pale malt', base_uom: 'kg', physical_form: 'granular' });
  await call(a, 'item_pack_upsert', { item_id: item.id, name: '25 kg sack', contains_qty: 25 });
  const supplier = (await call(a, 'supplier_upsert', { name: 'Example Maltings', origin: 'existing' })).supplier;
  await call(a, 'supplier_item_upsert', { supplier_id: supplier.id, item_id: item.id, purchase_pack: '25 kg sack', moq: 1000, lead_time_days: 10, is_preferred: true });
  await call(a, 'reorder_policy_set', { item_id: item.id, site_code: 'MAIN', method: 'days_of_cover', safety_days: 5, target_cover_days: 30 });
  await call(a, 'stock_move', { item_id: item.id, type: 'receipt', qty: 2650, site_code: 'MAIN', location_code: 'A-01' });
  // 1,800 kg used over the last 30 days.
  for (let d = 1; d <= 6; d += 1) {
    const occurred_at = new Date(Date.now() - d * 4 * 86400000).toISOString();
    await call(a, 'stock_move', { item_id: item.id, type: 'issue', qty: 300, site_code: 'MAIN', location_code: 'A-01', occurred_at });
  }
  return { item, supplier };
}

test('the report flags malt from real ledger usage and the preferred supplier', async () => {
  const a = await newActor();
  const { supplier } = await maltPlant(a);
  const r = await call(a, 'low_stock_report', {});
  assert.equal(r.items.length, 1);
  const row = r.items[0];
  assert.equal(row.status, 'reorder');
  assert.equal(row.on_hand, '850');
  assert.equal(row.daily_usage, '60');
  assert.equal(row.suggest_qty_base, '1000');
  assert.equal(row.suggest_display, '40 x 25 kg sack');
  assert.equal(row.preferred_supplier_id, supplier.id);
});

test('an open PO counts as on order and a quarantined lot is not usable', async () => {
  const a = await newActor();
  const { item, supplier } = await maltPlant(a);
  const po = await call(a, 'po_create', { supplier_id: supplier.id, site_code: 'MAIN', currency: 'USD', lines: [{ item_id: item.id, qty: 1000, price_per_base: '0.9' }] });
  await call(a, 'po_approve', { po_id: po.po_id, approved_max_amount: 900 });
  let r = await call(a, 'low_stock_report', { include_ok: true });
  assert.equal(r.items[0].status, 'ok');
  assert.equal(r.items[0].on_order, '1000');
  await call(a, 'stock_move', { item_id: item.id, type: 'transfer', qty: 700, site_code: 'MAIN', location_code: 'A-01', to_location_code: 'QC' });
  r = await call(a, 'low_stock_report', { include_ok: true });
  assert.equal(r.items[0].on_hand, '150');
  assert.equal(r.items[0].status, 'critical');
});

test('expiring lots are listed', async () => {
  const a = await newActor();
  await setupSite(a);
  const hops = await makeItem(a, { sku: 'HOPS', name: 'Citra', base_uom: 'kg', is_lot_tracked: true });
  const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  await call(a, 'stock_move', { item_id: hops.id, type: 'receipt', qty: 5, site_code: 'MAIN', location_code: 'A-01', lot_code: 'H1', expires_on: soon });
  const r = await call(a, 'low_stock_report', {});
  assert.deepEqual(r.expiring_lots.map((l: any) => l.lot_code), ['H1']);
});
