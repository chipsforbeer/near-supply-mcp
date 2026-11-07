import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase } from '../helpers/db.ts';
import { newActor, call, type Actor } from '../helpers/ops.ts';
import { setupSite, makeItem } from '../helpers/fixtures.ts';
import { OpError } from '../../src/ops/errors.ts';
import { landedCosts, packsNeeded, priceFor } from '../../src/ops/procurement/landed.ts';

before(resetTestDatabase);
const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;

test('packs needed respects MOQ; breaks pick the deepest reached', () => {
  assert.equal(packsNeeded('950', '25', null), 38n);
  assert.equal(packsNeeded('950', '25', '40'), 40n);
  assert.equal(priceFor(40n, '22.5', [{ min_packs: '20', price_per_pack: '22' }, { min_packs: '40', price_per_pack: '21.5' }]), '21.5');
  assert.equal(priceFor(10n, '22.5', [{ min_packs: '20', price_per_pack: '22' }]), '22.5');
});

test('freight is shared by line value within a quote', () => {
  const l = landedCosts([
    { quote_id: 'q', quote_line_id: 'a', qty_base: '100', pack_base_qty: '1', price_per_pack: '3', moq_packs: null, tooling_cost: null, breaks: [], quote_freight: '40' },
    { quote_id: 'q', quote_line_id: 'b', qty_base: '100', pack_base_qty: '1', price_per_pack: '1', moq_packs: null, tooling_cost: null, breaks: [], quote_freight: '40' },
  ]);
  assert.equal(l.get('a')!.freight_share, '30');
  assert.equal(l.get('b')!.freight_share, '10');
});

async function maltRfq(a: Actor) {
  await setupSite(a);
  const malt = await makeItem(a, { sku: 'MALT', name: 'Pale malt', base_uom: 'kg', physical_form: 'granular' });
  await call(a, 'item_pack_upsert', { item_id: malt.id, name: '25 kg sack', contains_qty: 25 });
  const A = (await call(a, 'supplier_upsert', { name: 'Example Maltings A', origin: 'existing' })).supplier;
  const B = (await call(a, 'supplier_upsert', { name: 'Example Maltings B', origin: 'existing' })).supplier;
  const C = (await call(a, 'supplier_upsert', { name: 'Example Maltings C', origin: 'discovered', allow_similar: true })).supplier;
  const rfq = await call(a, 'rfq_create', { site_code: 'MAIN', trigger: 'low_stock', lines: [{ item_id: malt.id, qty: 1000 }] });
  await call(a, 'rfq_add_recipients', { rfq_id: rfq.rfq_id, recipients: [{ supplier_id: A.id }, { supplier_id: B.id }, { supplier_id: C.id }] });
  return { malt, A, B, C, rfq, lineId: rfq.lines[0].id as string };
}

test('the worked example: B at 22.50 per sack plus freight beats A at 0.95 per kg delivered', async () => {
  const a = await newActor();
  const { malt, A, B, rfq, lineId } = await maltRfq(a);
  await call(a, 'quote_record', {
    rfq_id: rfq.rfq_id, supplier_id: A.id, received_at: '2026-11-04T08:00:00Z', currency: 'USD', lead_time_days: 7,
    lines: [{ rfq_line_id: lineId, item_id: malt.id, pack_qty: 1, pack_uom: 'kg', price_per_pack: '0.95' }],
  });
  const qb = await call(a, 'quote_record', {
    rfq_id: rfq.rfq_id, supplier_id: B.id, received_at: '2026-11-04T09:00:00Z', currency: 'USD', lead_time_days: 14, freight_cost: 40,
    lines: [{ rfq_line_id: lineId, item_id: malt.id, pack_qty: 1, pack: '25 kg sack', price_per_pack: '22.50', moq_packs: 40 }],
  });
  assert.equal(Number(qb.lines[0].pack_base_qty), 25);
  const cmp = await call(a, 'quote_compare', { rfq_id: rfq.rfq_id });
  const offers = cmp.lines[0].offers;
  assert.deepEqual(offers.map((o: any) => [o.supplier, o.landed_per_base]), [['Example Maltings B', '0.94'], ['Example Maltings A', '0.95']]);
  assert.equal(offers[0].packs, '40');
  const status = await call(a, 'outreach_status', { rfq_id: rfq.rfq_id });
  assert.equal(status.recipients.find((r: any) => r.supplier_id === B.id).status, 'quoted');
});

test('a quote in another currency is flagged until a rate is recorded', async () => {
  const a = await newActor();
  const { malt, A, C, rfq, lineId } = await maltRfq(a);
  await call(a, 'quote_record', {
    rfq_id: rfq.rfq_id, supplier_id: A.id, received_at: '2026-11-04T08:00:00Z', currency: 'USD',
    lines: [{ rfq_line_id: lineId, item_id: malt.id, pack_qty: 1, pack_uom: 'kg', price_per_pack: '0.95' }],
  });
  await call(a, 'quote_record', {
    rfq_id: rfq.rfq_id, supplier_id: C.id, received_at: '2026-11-04T10:00:00Z', currency: 'EUR',
    lines: [{ rfq_line_id: lineId, item_id: malt.id, pack_qty: 1, pack_uom: 't', price_per_pack: '800' }],
  });
  let cmp = await call(a, 'quote_compare', { rfq_id: rfq.rfq_id, currency: 'USD' });
  const eur = cmp.lines[0].offers.find((o: any) => o.quoted_currency === 'EUR');
  assert.equal(eur.needs_exchange_rate, true);
  assert.equal(eur.landed_per_base, null);
  await call(a, 'fx_rate_record', { from_currency: 'EUR', to_currency: 'USD', rate: '1.1', as_of: '2026-11-04', source: 'example reference rate' });
  cmp = await call(a, 'quote_compare', { rfq_id: rfq.rfq_id, currency: 'USD' });
  const converted = cmp.lines[0].offers.find((o: any) => o.quoted_currency === 'EUR');
  assert.equal(converted.landed_per_base, '0.88');
  assert.equal(cmp.lines[0].offers[0].supplier, 'Example Maltings C');
});

test('quotes need the supplier to be a recipient and the right RFQ line', async () => {
  const a = await newActor();
  const { malt, rfq, lineId } = await maltRfq(a);
  const outsider = (await call(a, 'supplier_upsert', { name: 'Outsider Grain', origin: 'existing' })).supplier;
  await assert.rejects(
    call(a, 'quote_record', { rfq_id: rfq.rfq_id, supplier_id: outsider.id, received_at: '2026-11-04T08:00:00Z', currency: 'USD',
      lines: [{ rfq_line_id: lineId, item_id: malt.id, pack_qty: 1, price_per_pack: 1 }] }),
    isCode('conflict'),
  );
});
