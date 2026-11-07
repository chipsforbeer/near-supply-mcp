import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase } from '../helpers/db.ts';
import { newActor, call } from '../helpers/ops.ts';
import { OpError } from '../../src/ops/errors.ts';

before(resetTestDatabase);
const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;

const sheet = {
  sku: 'SS304-1.5', name: '304 sheet 1.5 mm 2B', category: 'raw_material', physical_form: 'sheet',
  sourcing_type: 'commodity', base_uom: 'kg', is_lot_tracked: true,
};

test('upsert creates then updates by SKU, base unit is fixed', async () => {
  const a = await newActor();
  const created = await call(a, 'item_upsert', sheet);
  assert.equal(created.created, true);
  const updated = await call(a, 'item_upsert', { sku: 'SS304-1.5', storage_notes: 'Keep dry', brand: 'Northbeck' });
  assert.equal(updated.created, false);
  assert.equal(updated.item.storage_notes, 'Keep dry');
  assert.equal(updated.item.name, sheet.name);
  await assert.rejects(call(a, 'item_upsert', { sku: 'SS304-1.5', base_uom: 'each' }), isCode('invalid_arguments'));
  await assert.rejects(call(a, 'item_upsert', { sku: 'NEW-1', name: 'x' }), isCode('invalid_arguments'));
});

test('packs nest and compute base quantities', async () => {
  const a = await newActor();
  const { item } = await call(a, 'item_upsert', { ...sheet, sku: 'MALT', name: 'Pale malt', base_uom: 'kg', physical_form: 'granular' });
  const sack = await call(a, 'item_pack_upsert', { item_id: item.id, name: '25 kg sack', contains_qty: 25, container_kind: 'sack' });
  assert.equal(Number(sack.base_qty), 25);
  const pallet = await call(a, 'item_pack_upsert', { item_id: item.id, name: 'pallet', contains_qty: 40, contains_pack: '25 kg sack', container_kind: 'pallet' });
  assert.equal(Number(pallet.base_qty), 1000);
  const got = await call(a, 'item_get', { sku: 'MALT' });
  assert.deepEqual(got.packs.map((p: any) => [p.name, Number(p.base_qty), p.container_kind]), [
    ['25 kg sack', 25, 'sack'],
    ['pallet', 1000, 'pallet'],
  ]);
});

test('identifiers make items findable by MPN', async () => {
  const a = await newActor();
  const { item } = await call(a, 'item_upsert', {
    sku: 'BRG-6205', name: 'Bearing 6205-2RS', category: 'mro_spare', physical_form: 'discrete', sourcing_type: 'catalog', base_uom: 'each',
  });
  await call(a, 'item_identifier_add', { item_id: item.id, kind: 'mpn', value: '6205-2RSH', manufacturer: 'Example Bearings', is_primary: true });
  const found = await call(a, 'item_search', { identifier: '6205-2rsh' });
  assert.deepEqual(found.items.map((i: any) => i.sku), ['BRG-6205']);
  const byName = await call(a, 'item_search', { query: 'bearing' });
  assert.equal(byName.items.length, 1);
});

test('cross-dimension conversions are explicit', async () => {
  const a = await newActor();
  const { item } = await call(a, 'item_upsert', {
    sku: 'NAOH-50', name: 'Caustic soda 50%', category: 'chemical', physical_form: 'liquid', sourcing_type: 'commodity', base_uom: 'kg',
  });
  await assert.rejects(call(a, 'item_conversion_set', { item_id: item.id, from_uom: 'g', to_uom: 'kg', factor: 0.001 }), isCode('invalid_arguments'));
  const c = await call(a, 'item_conversion_set', { item_id: item.id, from_uom: 'L', to_uom: 'kg', factor: '1.52' });
  assert.equal(Number(c.factor), 1.52);
});

test('locations and sites', async () => {
  const a = await newActor();
  await assert.rejects(call(a, 'location_upsert', { site_code: 'MAIN', code: 'A-01', name: 'Rack A1', kind: 'rack' }), isCode('invalid_arguments'));
  const r = await call(a, 'location_upsert', {
    site_code: 'MAIN', site_name: 'Main plant', timezone: 'Asia/Taipei', code: 'A-01', name: 'Rack A1', kind: 'rack',
  });
  assert.equal(r.site_code, 'MAIN');
  const q = await call(a, 'location_upsert', { site_code: 'MAIN', code: 'QC', name: 'Quarantine', kind: 'quarantine' });
  assert.equal(q.location.kind, 'quarantine');
});

test('another company cannot see or extend the item', async () => {
  const a = await newActor();
  const b = await newActor();
  const { item } = await call(a, 'item_upsert', { ...sheet, sku: 'PRIVATE-1' });
  await assert.rejects(call(b, 'item_get', { item_id: item.id }), isCode('not_found'));
  await assert.rejects(call(b, 'item_pack_upsert', { item_id: item.id, name: 'box', contains_qty: 1 }), isCode('not_found'));
  const search = await call(b, 'item_search', { query: '304' });
  assert.equal(search.items.length, 0);
});

test('shared container types are listed', async () => {
  const a = await newActor();
  const r = await call(a, 'container_type_list');
  assert.ok(r.items.some((c: any) => c.name === '200 L drum' && c.shared));
});
