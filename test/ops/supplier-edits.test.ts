import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase } from '../helpers/db.ts';
import { newActor, call, type Actor } from '../helpers/ops.ts';
import { makeItem } from '../helpers/fixtures.ts';
import { OpError } from '../../src/ops/errors.ts';

before(resetTestDatabase);
const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;

async function fullSupplier(a: Actor): Promise<string> {
  return (await call(a, 'supplier_upsert', {
    name: 'Example Edit Co', origin: 'discovered', legal_name: 'Example Edit Co Ltd', website: 'https://edit.example.com',
    country_code: 'GB', supplier_type: 'distributor', capabilities: ['cutting'], currency: 'USD', payment_terms: '30 days',
    incoterms: 'DAP', rating: 4, notes: 'Met at a trade fair', tax_id: 'EX-VAT-7', registration_number: 'EX-REG-7', tags: ['steel'],
  })).supplier.id;
}

test('every optional supplier field can be changed or cleared; left-out fields stay', async () => {
  const a = await newActor();
  const id = await fullSupplier(a);
  await call(a, 'supplier_upsert', {
    supplier_id: id, origin: 'existing', legal_name: null, website: null, email_domain: null, country_code: null, supplier_type: null,
    currency: null, payment_terms: null, incoterms: null, rating: null, notes: null, tax_id: null, registration_number: null,
    capabilities: [], tags: [],
  });
  const s = await call(a, 'supplier_get', { supplier_id: id });
  assert.equal(s.origin, 'existing');
  for (const f of ['legal_name', 'website', 'email_domain', 'country_code', 'supplier_type', 'default_currency', 'payment_terms',
    'default_incoterms', 'rating', 'notes', 'tax_id', 'registration_number']) {
    assert.equal(s[f], null, f);
  }
  assert.deepEqual([s.capabilities, s.tags, s.name], [[], [], 'Example Edit Co']);
  await assert.rejects(call(a, 'supplier_upsert', { supplier_id: id, name: null }), isCode('invalid_arguments'));
});

test('a contact can be updated without repeating its name, and its fields cleared', async () => {
  const a = await newActor();
  const id = await fullSupplier(a);
  const c = await call(a, 'contact_upsert', { supplier_id: id, full_name: 'Sam Example', job_title: 'Buyer', department: 'Sales', notes: 'x' });
  const u = await call(a, 'contact_upsert', { supplier_id: id, contact_id: c.contact.id, job_title: 'Sales manager', department: null, notes: null });
  assert.deepEqual([u.contact.full_name, u.contact.job_title, u.contact.department, u.contact.notes], ['Sam Example', 'Sales manager', null, null]);
  await assert.rejects(call(a, 'contact_upsert', { supplier_id: id, job_title: 'No name' }), isCode('invalid_arguments'));
});

test('a contact method can be corrected, moved to the company, and retired', async () => {
  const a = await newActor();
  const id = await fullSupplier(a);
  const c = await call(a, 'contact_upsert', { supplier_id: id, full_name: 'Sam Example' });
  const m = await call(a, 'contact_method_add', { supplier_id: id, contact_id: c.contact.id, type: 'email', value: 'sam@edti.example.com', label: 'work' });
  const fixed = await call(a, 'contact_method_update', { supplier_id: id, contact_method_id: m.id, value: 'sam@edit.example.com', label: null });
  assert.deepEqual([fixed.value, fixed.label], ['sam@edit.example.com', null]);
  await assert.rejects(call(a, 'contact_method_update', { supplier_id: id, contact_method_id: m.id, value: 'not an email' }), isCode('invalid_arguments'));
  const moved = await call(a, 'contact_method_update', { supplier_id: id, contact_method_id: m.id, contact_id: null });
  assert.equal(moved.contact_id, null);
  let s = await call(a, 'supplier_get', { supplier_id: id });
  assert.deepEqual(s.company_methods.map((x: any) => x.value), ['sam@edit.example.com']);

  await call(a, 'contact_method_update', { supplier_id: id, contact_method_id: m.id, remove: true });
  s = await call(a, 'supplier_get', { supplier_id: id });
  assert.equal(s.company_methods.length, 0, 'a retired method is no longer shown');
  await assert.rejects(
    call(a, 'interaction_log', { supplier_id: id, contact_method_id: m.id, direction: 'out', channel: 'email', summary: 'x', occurred_at: new Date().toISOString() }),
    isCode('conflict'),
  );
  const back = await call(a, 'contact_method_add', { supplier_id: id, type: 'email', value: 'sam@edit.example.com' });
  assert.equal(back.id, m.id, 'adding it again brings the same method back');
  assert.equal((await call(a, 'supplier_get', { supplier_id: id })).company_methods.length, 1);
});

test('offering fields can be cleared', async () => {
  const a = await newActor();
  const id = await fullSupplier(a);
  const o = await call(a, 'supplier_offering_upsert', {
    supplier_id: id, kind: 'service', category: 'Cutting', description: 'd', min_order: 'm', lead_time_days_min: 1, lead_time_days_max: 3,
    price_note: 'p', source: 's',
  });
  const u = await call(a, 'supplier_offering_upsert', {
    supplier_id: id, offering_id: o.offering_id, description: null, min_order: null, lead_time_days_min: null, lead_time_days_max: null,
    price_note: null, source: null,
  });
  assert.deepEqual([u.description, u.min_order, u.lead_time_days_min, u.lead_time_days_max, u.price_note, u.source, u.category],
    [null, null, null, null, null, null, 'Cutting']);
});

test('what a supplier sells us can be changed and cleared', async () => {
  const a = await newActor();
  const id = await fullSupplier(a);
  const item = await makeItem(a, { sku: 'EDIT-1', name: 'Edit part' });
  await call(a, 'supplier_item_upsert', { supplier_id: id, item_id: item.id, supplier_sku: 'S-1', lead_time_days: 9, last_price: '2.5', last_price_currency: 'USD' });
  const u = await call(a, 'supplier_item_upsert', { supplier_id: id, item_id: item.id, supplier_sku: 'S-2', lead_time_days: null, last_price: null, last_price_currency: null });
  assert.deepEqual([u.supplier_sku, u.lead_time_days, u.last_price, u.last_price_currency], ['S-2', null, null, null]);
});
