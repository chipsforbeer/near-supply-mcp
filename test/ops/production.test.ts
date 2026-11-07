import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase } from '../helpers/db.ts';
import { newActor, call, type Actor } from '../helpers/ops.ts';
import { setupSite, makeItem } from '../helpers/fixtures.ts';
import { OpError } from '../../src/ops/errors.ts';

before(resetTestDatabase);
const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;
const at = { site_code: 'MAIN', location_code: 'A-01' };

// An enclosure shop: one enclosure takes 9.8 kg sheet (+12% offcuts), 12 bolts and 2 hinges.
async function shop(a: Actor) {
  await setupSite(a);
  const sheet = await makeItem(a, { sku: 'SS304', name: '304 sheet', physical_form: 'sheet', base_uom: 'kg' });
  const bolt = await makeItem(a, { sku: 'M6x16', name: 'M6x16 bolt', category: 'component', sourcing_type: 'catalog' });
  const hinge = await makeItem(a, { sku: 'HINGE', name: 'Hinge', category: 'component', sourcing_type: 'catalog' });
  const enclosure = await makeItem(a, { sku: 'ENC-400', name: 'Enclosure 400x300x200', category: 'finished_good', sourcing_type: 'made_to_print' });
  await call(a, 'stock_move', { item_id: sheet.id, type: 'receipt', qty: 708, ...at });
  await call(a, 'stock_move', { item_id: bolt.id, type: 'receipt', qty: 1000, ...at });
  await call(a, 'stock_move', { item_id: hinge.id, type: 'receipt', qty: 100, ...at });
  await call(a, 'bom_upsert', {
    output_item_id: enclosure.id, batch_qty: 1,
    lines: [
      { item_id: sheet.id, qty: '9.8', scrap_factor: 0.12 },
      { item_id: bolt.id, qty: 12 },
      { item_id: hinge.id, qty: 2 },
    ],
  });
  return { sheet, bolt, hinge, enclosure };
}

async function onHand(a: Actor, itemId: string): Promise<number> {
  const r = await call(a, 'stock_levels', { item_id: itemId, include_zero: true });
  return r.items.reduce((s: number, i: any) => s + Number(i.qty_base), 0);
}

test('a run consumes components scaled with scrap and adds the output', async () => {
  const a = await newActor();
  const { sheet, bolt, hinge, enclosure } = await shop(a);
  const r = await call(a, 'production_run_record', {
    output_item_id: enclosure.id, run_code: 'WO-2026-114', site_code: 'MAIN',
    consume_location_code: 'A-01', output_location_code: 'B-01', actual_output_qty: 40,
  });
  const sheetUsed = r.consumed.find((c: any) => c.item_id === sheet.id);
  assert.equal(sheetUsed.qty_base, '439.04');
  assert.equal(await onHand(a, sheet.id), 708 - 439.04);
  assert.equal(await onHand(a, bolt.id), 1000 - 480);
  assert.equal(await onHand(a, hinge.id), 100 - 80);
  assert.equal(await onHand(a, enclosure.id), 40);
});

test('actual amounts override the recipe', async () => {
  const a = await newActor();
  const { sheet, enclosure } = await shop(a);
  const r = await call(a, 'production_run_record', {
    output_item_id: enclosure.id, run_code: 'WO-2', site_code: 'MAIN', consume_location_code: 'A-01',
    output_location_code: 'B-01', actual_output_qty: 40, actual_lines: [{ item_id: sheet.id, qty: 420 }],
  });
  assert.equal(r.consumed.find((c: any) => c.item_id === sheet.id).qty_base, '420');
  assert.equal(await onHand(a, sheet.id), 288);
});

test('a missing component fails the whole run and writes nothing', async () => {
  const a = await newActor();
  const { sheet, hinge, enclosure } = await shop(a);
  await assert.rejects(
    call(a, 'production_run_record', {
      output_item_id: enclosure.id, run_code: 'WO-3', site_code: 'MAIN', consume_location_code: 'A-01',
      output_location_code: 'B-01', actual_output_qty: 60,
    }),
    isCode('conflict'),
  );
  assert.equal(await onHand(a, sheet.id), 708);
  assert.equal(await onHand(a, hinge.id), 100);
  assert.equal(await onHand(a, enclosure.id), 0);
});

test('run codes are unique', async () => {
  const a = await newActor();
  const { enclosure } = await shop(a);
  const run = { output_item_id: enclosure.id, run_code: 'WO-9', site_code: 'MAIN', consume_location_code: 'A-01', output_location_code: 'B-01', actual_output_qty: 1 };
  await call(a, 'production_run_record', run);
  await assert.rejects(call(a, 'production_run_record', run), isCode('conflict'));
});

test('a new BOM version retires the old one', async () => {
  const a = await newActor();
  const { sheet, enclosure } = await shop(a);
  const v2 = await call(a, 'bom_upsert', { output_item_id: enclosure.id, batch_qty: 1, lines: [{ item_id: sheet.id, qty: 10 }] });
  assert.equal(v2.version, 2);
  const active = await call(a, 'bom_get', { output_item_id: enclosure.id });
  assert.equal(active.version, 2);
  const old = await call(a, 'bom_get', { output_item_id: enclosure.id, version: 1 });
  assert.equal(old.status, 'retired');
});

test('lot-tracked components are taken first-expiring-first', async () => {
  const a = await newActor();
  await setupSite(a);
  const hops = await makeItem(a, { sku: 'HOP-CITRA', name: 'Citra pellets', base_uom: 'kg', physical_form: 'granular', is_lot_tracked: true });
  const beer = await makeItem(a, { sku: 'LAGER', name: 'Lager bulk', base_uom: 'L', physical_form: 'liquid', category: 'finished_good', is_lot_tracked: true });
  await call(a, 'stock_move', { item_id: hops.id, type: 'receipt', qty: 3, ...at, lot_code: 'H-LATE', expires_on: '2027-06-30' });
  await call(a, 'stock_move', { item_id: hops.id, type: 'receipt', qty: 3, ...at, lot_code: 'H-EARLY', expires_on: '2027-01-31' });
  await call(a, 'bom_upsert', { output_item_id: beer.id, batch_qty: 2000, lines: [{ item_id: hops.id, qty: 4 }] });
  const r = await call(a, 'production_run_record', {
    output_item_id: beer.id, run_code: 'B114', site_code: 'MAIN', consume_location_code: 'A-01', output_location_code: 'B-01', actual_output_qty: 2000,
  });
  assert.deepEqual(r.consumed[0].lots.map((l: any) => [l.lot_code, l.qty_base]), [['H-EARLY', '3'], ['H-LATE', '1']]);
  assert.equal(r.output.lot_code, 'B114');
});
