import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase } from '../helpers/db.ts';
import { newActor, call } from '../helpers/ops.ts';
import { makeItem } from '../helpers/fixtures.ts';
import { OpError } from '../../src/ops/errors.ts';
import { companyDomain, normName } from '../../src/domain/normalize.ts';

before(resetTestDatabase);
const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;

test('normalisation ignores legal suffixes, punctuation and free mail domains', () => {
  assert.equal(normName('ACME Metals Ltd.'), normName('Acme Metals'));
  assert.equal(normName('Acme Metals Co., Ltd.'), 'acme metals');
  assert.equal(companyDomain('sales@acme-metals.example'), 'acme-metals.example');
  assert.equal(companyDomain('https://www.acme-metals.example/contact'), 'acme-metals.example');
  assert.equal(companyDomain('someone@gmail.com'), null);
});

test('duplicates are found by name, domain and phone', async () => {
  const a = await newActor();
  const { supplier } = await call(a, 'supplier_upsert', { name: 'ACME Metals Ltd.', origin: 'existing', website: 'https://www.acme-metals.example' });
  await call(a, 'contact_method_add', { supplier_id: supplier.id, type: 'phone', value: '+886 3 555 0142' });
  const byName = await call(a, 'supplier_find_duplicates', { name: 'Acme Metals' });
  assert.deepEqual(byName.matches.map((m: any) => m.matched_on), [['name']]);
  const byDomain = await call(a, 'supplier_find_duplicates', { email: 'quotes@acme-metals.example' });
  assert.deepEqual(byDomain.matches[0].matched_on, ['domain']);
  const byPhone = await call(a, 'supplier_find_duplicates', { phone: '03-555-0142' });
  assert.deepEqual(byPhone.matches[0].matched_on, ['phone']);
  const gmail = await call(a, 'supplier_find_duplicates', { email: 'someone@gmail.com' });
  assert.equal(gmail.matches.length, 0);
});

test('creating a likely duplicate is refused unless allowed', async () => {
  const a = await newActor();
  await call(a, 'supplier_upsert', { name: 'Northside Steel Co.', origin: 'existing' });
  await assert.rejects(call(a, 'supplier_upsert', { name: 'Northside Steel', origin: 'discovered' }), isCode('conflict'));
  const ok = await call(a, 'supplier_upsert', { name: 'Northside Steel', origin: 'discovered', allow_similar: true, discovery_sources: ['https://example.com/dir'] });
  assert.equal(ok.supplier.status, 'prospect');
});

test('import creates suppliers with contacts and reports duplicates instead of inserting', async () => {
  const a = await newActor();
  await call(a, 'supplier_upsert', { name: 'Harbor Fasteners', origin: 'existing' });
  const r = await call(a, 'supplier_import', {
    suppliers: [
      {
        name: 'Valley Coatings', website: 'valley-coatings.example', capabilities: ['powder_coating'],
        contacts: [{ full_name: 'Example Contact', handles: ['quotes'], language: 'zh-TW', methods: [{ type: 'email', value: 'quotes@valley-coatings.example', is_preferred: true }] }],
      },
      { name: 'Harbor Fasteners Inc.' },
    ],
  });
  assert.equal(r.created, 1);
  assert.equal(r.duplicates, 1);
  const created = r.results.find((x: any) => x.result === 'created');
  const got = await call(a, 'supplier_get', { supplier_id: created.supplier_id });
  assert.equal(got.status, 'approved');
  assert.equal(got.contacts[0].methods[0].value, 'quotes@valley-coatings.example');
  const byCap = await call(a, 'supplier_search', { capability: 'powder_coating' });
  assert.deepEqual(byCap.items.map((s: any) => s.name), ['Valley Coatings']);
});

test('payout accounts need approve scope and keep history; supplier_get masks them', async () => {
  const writer = await newActor({ scopes: ['read', 'write'] });
  const { supplier } = await call(writer, 'supplier_upsert', { name: 'Lakeside Metals', origin: 'existing' });
  await assert.rejects(
    call(writer, 'supplier_payout_account_set', { supplier_id: supplier.id, network: 'near', account_id: 'lakeside.testnet', token: 'usdc', note: 'confirmed by phone' }),
    isCode('forbidden'),
  );
  const approver = await newActor({ companyId: writer.session.companyId, scopes: ['read', 'write', 'approve'] });
  await call(approver, 'supplier_payout_account_set', { supplier_id: supplier.id, network: 'near', account_id: 'lakeside.testnet', token: 'usdc', note: 'confirmed by phone' });
  const second = await call(approver, 'supplier_payout_account_set', {
    supplier_id: supplier.id, network: 'near', account_id: 'lakeside-pay.testnet', token: 'usdc', note: 'new account confirmed by phone',
  });
  assert.equal(second.replaced, 'lakeside.testnet');
  const got = await call(writer, 'supplier_get', { supplier_id: supplier.id });
  assert.equal(got.payout_accounts.length, 1);
  assert.equal(got.payout_accounts[0].account_id, '...estnet');
  await assert.rejects(
    call(approver, 'supplier_payout_account_set', { supplier_id: supplier.id, network: 'near', account_id: 'Bad Account!', token: 'usdc', note: 'xxxxx' }),
    isCode('invalid_arguments'),
  );
});

test('supplier items: one preferred supplier per item', async () => {
  const a = await newActor();
  const malt = await makeItem(a, { sku: 'MALT', name: 'Pale malt', base_uom: 'kg', physical_form: 'granular' });
  await call(a, 'item_pack_upsert', { item_id: malt.id, name: '25 kg sack', contains_qty: 25 });
  const s1 = (await call(a, 'supplier_upsert', { name: 'Maltings One', origin: 'existing' })).supplier;
  const s2 = (await call(a, 'supplier_upsert', { name: 'Maltings Two', origin: 'existing' })).supplier;
  await call(a, 'supplier_item_upsert', { supplier_id: s1.id, item_id: malt.id, purchase_pack: '25 kg sack', moq: 40, moq_pack: '25 kg sack', lead_time_days: 7, is_preferred: true });
  const second = await call(a, 'supplier_item_upsert', { supplier_id: s2.id, item_id: malt.id, lead_time_days: 14, is_preferred: true, last_price: '22.5', last_price_per: 'base', last_price_currency: 'USD' });
  assert.equal(second.is_preferred, true);
  const list = await call(a, 'supplier_search', { item_id: malt.id });
  assert.deepEqual(list.items.map((s: any) => [s.name, s.is_preferred]), [['Maltings Two', true], ['Maltings One', false]]);
  const one = await call(a, 'supplier_get', { supplier_id: s1.id });
  assert.equal(Number(one.items[0].moq_base), 1000);
});

test('contacts can be marked never to contact on our behalf', async () => {
  const a = await newActor();
  const { supplier } = await call(a, 'supplier_upsert', { name: 'Quiet Supplier', origin: 'existing' });
  const c = await call(a, 'contact_upsert', { supplier_id: supplier.id, full_name: 'Example Owner', may_contact_on_behalf: false });
  assert.equal(c.contact.may_contact_on_behalf, false);
  await assert.rejects(call(a, 'contact_method_add', { supplier_id: supplier.id, type: 'email', value: 'not-an-email' }), isCode('invalid_arguments'));
});

test('another company cannot see or change the supplier', async () => {
  const a = await newActor();
  const b = await newActor();
  const { supplier } = await call(a, 'supplier_upsert', { name: 'Private Supplier', origin: 'existing' });
  await assert.rejects(call(b, 'supplier_get', { supplier_id: supplier.id }), isCode('not_found'));
  await assert.rejects(call(b, 'supplier_upsert', { supplier_id: supplier.id, notes: 'x' }), isCode('not_found'));
  await assert.rejects(call(b, 'contact_upsert', { supplier_id: supplier.id, full_name: 'x' }), isCode('not_found'));
  const dup = await call(b, 'supplier_find_duplicates', { name: 'Private Supplier' });
  assert.equal(dup.matches.length, 0);
});
