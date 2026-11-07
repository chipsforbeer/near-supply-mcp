import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase } from '../helpers/db.ts';
import { newActor, call, type Actor } from '../helpers/ops.ts';
import { OpError } from '../../src/ops/errors.ts';

before(resetTestDatabase);
const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;

async function supplier(a: Actor, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await call(a, 'supplier_upsert', { name, origin: 'existing', ...extra })).supplier.id;
}

test('a supplier keeps its tax and registration numbers', async () => {
  const a = await newActor();
  const id = await supplier(a, 'Example Steel Co', { tax_id: 'EX-VAT-0001', registration_number: 'EX-REG-42' });
  const s = await call(a, 'supplier_get', { supplier_id: id });
  assert.deepEqual([s.tax_id, s.registration_number], ['EX-VAT-0001', 'EX-REG-42']);
  await call(a, 'supplier_upsert', { supplier_id: id, tax_id: 'EX-VAT-0002' });
  assert.equal((await call(a, 'supplier_get', { supplier_id: id })).tax_id, 'EX-VAT-0002');
});

test('offerings describe what a supplier can supply beyond our own items', async () => {
  const a = await newActor();
  const id = await supplier(a, 'Example Laser Works');
  const doc = await call(a, 'document_capture_text', { title: 'Price list', kind: 'other', text: 'Laser cutting price list.', source: 'note' });
  const o = await call(a, 'supplier_offering_upsert', {
    supplier_id: id, kind: 'service', category: 'Laser cutting',
    description: 'Fibre laser, stainless and mild steel up to 12 mm, sheets up to 3 x 1.5 m.',
    tags: ['laser', 'cutting'], min_order: 'USD 150 per order', lead_time_days_min: 3, lead_time_days_max: 7,
    price_note: 'Per sheet, quoted on drawing', source: 'https://laser.example.com/services', document_id: doc.document_id,
  });
  assert.ok(o.offering_id);
  await call(a, 'supplier_offering_upsert', { supplier_id: id, kind: 'product', category: 'Old bar stock', status: 'discontinued' });
  const s = await call(a, 'supplier_get', { supplier_id: id });
  assert.deepEqual(s.offerings.map((x: any) => [x.category, x.status]), [['Laser cutting', 'active'], ['Old bar stock', 'discontinued']]);
  assert.equal(s.offerings[0].document_id, doc.document_id);

  const updated = await call(a, 'supplier_offering_upsert', { supplier_id: id, offering_id: o.offering_id, lead_time_days_max: 10 });
  assert.equal(updated.lead_time_days_max, 10);
  assert.equal(updated.category, 'Laser cutting');
  await assert.rejects(
    call(a, 'supplier_offering_upsert', { supplier_id: id, kind: 'service', category: 'Bad', lead_time_days_min: 9, lead_time_days_max: 2 }),
    isCode('invalid_arguments'),
  );
});

test('suppliers can be found by what they offer; discontinued offerings do not count', async () => {
  const a = await newActor();
  const laser = await supplier(a, 'Example Laser Works');
  const coat = await supplier(a, 'Example Coaters');
  await call(a, 'supplier_offering_upsert', { supplier_id: laser, kind: 'service', category: 'Laser cutting', description: 'Stainless up to 12 mm' });
  await call(a, 'supplier_offering_upsert', { supplier_id: coat, kind: 'service', category: 'Powder coating', description: 'RAL colours, stainless and steel' });
  await call(a, 'supplier_offering_upsert', { supplier_id: coat, kind: 'service', category: 'Laser engraving', status: 'discontinued' });
  const byOffer = await call(a, 'supplier_search', { offering: 'laser' });
  assert.deepEqual(byOffer.items.map((s: any) => s.name), ['Example Laser Works']);
  assert.deepEqual(byOffer.items[0].matched_offerings, ['Laser cutting']);
  assert.deepEqual((await call(a, 'supplier_search', { offering: 'stainless' })).items.map((s: any) => s.name).sort(), ['Example Coaters', 'Example Laser Works']);
});

test('import brings offerings and registration details along', async () => {
  const a = await newActor();
  const r = await call(a, 'supplier_import', {
    suppliers: [{
      name: 'Example Imported Supplier', tax_id: 'EX-VAT-9', registration_number: 'EX-REG-9',
      offerings: [{ kind: 'product', category: 'Gaskets', description: 'EPDM and NBR' }],
    }],
  });
  const s = await call(a, 'supplier_get', { supplier_id: r.results[0].supplier_id });
  assert.deepEqual([s.tax_id, s.registration_number], ['EX-VAT-9', 'EX-REG-9']);
  assert.deepEqual(s.offerings.map((o: any) => o.category), ['Gaskets']);
});

test("another company's supplier cannot be given offerings", async () => {
  const a = await newActor();
  const b = await newActor();
  const id = await supplier(a, 'Example Private Supplier');
  await assert.rejects(call(b, 'supplier_offering_upsert', { supplier_id: id, kind: 'product', category: 'x' }), isCode('not_found'));
});
