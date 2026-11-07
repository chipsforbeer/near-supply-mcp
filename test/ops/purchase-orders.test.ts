import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase } from '../helpers/db.ts';
import { newActor, call, type Actor } from '../helpers/ops.ts';
import { setupSite, makeItem } from '../helpers/fixtures.ts';
import { OpError } from '../../src/ops/errors.ts';

before(resetTestDatabase);
const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;

async function draftPo(a: Actor) {
  await setupSite(a);
  const sheet = await makeItem(a, { sku: 'SS304', name: '304 sheet', base_uom: 'kg', physical_form: 'sheet', is_lot_tracked: true });
  await call(a, 'item_pack_upsert', { item_id: sheet.id, name: 'bundle', contains_qty: 708 });
  const supplier = (await call(a, 'supplier_upsert', { name: 'Example Steel C', origin: 'existing' })).supplier;
  const po = await call(a, 'po_create', {
    supplier_id: supplier.id, site_code: 'MAIN', currency: 'USD', freight_cost: 40,
    lines: [{ item_id: sheet.id, qty: 2, pack: 'bundle', price_per_base: '3.1' }],
  });
  return { sheet, supplier, po };
}

test('a PO total includes freight; approval needs the approve scope and a cap at least the total', async () => {
  const writer = await newActor({ scopes: ['read', 'write'] });
  const { po } = await draftPo(writer);
  assert.equal(po.po_code, 'PO-0001');
  assert.equal(Number(po.total), 1416 * 3.1 + 40);
  await assert.rejects(call(writer, 'po_approve', { po_id: po.po_id, approved_max_amount: 5000 }), isCode('forbidden'));
  const approver = await newActor({ companyId: writer.session.companyId });
  await assert.rejects(call(approver, 'po_approve', { po_id: po.po_id, approved_max_amount: 100 }), isCode('invalid_arguments'));
  const ok = await call(approver, 'po_approve', { po_id: po.po_id, approved_max_amount: 4500 });
  assert.equal(ok.status, 'approved');
});

test('payment instruction is refused until approved and a payout account exists, then paid is recorded', async () => {
  const a = await newActor();
  const { po, supplier } = await draftPo(a);
  await assert.rejects(call(a, 'po_payment_instruction', { po_id: po.po_id }), isCode('conflict'));
  await call(a, 'po_approve', { po_id: po.po_id, approved_max_amount: 4500 });
  await assert.rejects(call(a, 'po_payment_instruction', { po_id: po.po_id }), (e: unknown) => e instanceof OpError && /payout account/.test(e.message));
  await call(a, 'supplier_payout_account_set', { supplier_id: supplier.id, network: 'near', account_id: 'example-steel.testnet', token: 'usdc', note: 'confirmed by phone' });
  const ins = await call(a, 'po_payment_instruction', { po_id: po.po_id });
  assert.equal(ins.account_id, 'example-steel.testnet');
  assert.equal(Number(ins.amount), 1416 * 3.1 + 40);
  assert.equal(Number(ins.approval.approved_max_amount), 4500);
  await assert.rejects(call(a, 'po_payment_instruction', { po_id: po.po_id }), isCode('conflict'));
  const paid = await call(a, 'po_payment_record', { po_id: po.po_id, network: 'near', payment_ref: 'tx-example-0001', outcome: 'paid' });
  assert.equal(paid.payment_status, 'paid');
  await assert.rejects(call(a, 'po_payment_instruction', { po_id: po.po_id }), isCode('conflict'));
});

test('receiving: partial, then full; over-receipt refused; lots carry the supplier', async () => {
  const a = await newActor();
  const { po } = await draftPo(a);
  await call(a, 'po_approve', { po_id: po.po_id, approved_max_amount: 4500 });
  const line = po.lines[0].po_line_id;
  const first = await call(a, 'po_receive', { po_id: po.po_id, location_code: 'A-01', lines: [{ po_line_id: line, qty: 1, pack: 'bundle', lot_code: 'HEAT-1' }] });
  assert.equal(first.status, 'partially_received');
  await assert.rejects(
    call(a, 'po_receive', { po_id: po.po_id, location_code: 'A-01', lines: [{ po_line_id: line, qty: 709, lot_code: 'HEAT-2' }] }),
    isCode('conflict'),
  );
  const second = await call(a, 'po_receive', { po_id: po.po_id, location_code: 'QC', lines: [{ po_line_id: line, qty: 708, lot_code: 'HEAT-2' }] });
  assert.equal(second.status, 'received');
  const got = await call(a, 'po_get', { po_code: 'PO-0001' });
  assert.equal(Number(got.lines[0].received_qty_base), 1416);
  const levels = await call(a, 'stock_levels', {});
  const heat2 = levels.items.find((i: any) => i.lot_code === 'HEAT-2');
  assert.equal(heat2.lot_status, 'quarantine');
});

test('a draft PO cannot be received; cancelled POs stop', async () => {
  const a = await newActor();
  const { po } = await draftPo(a);
  await assert.rejects(
    call(a, 'po_receive', { po_id: po.po_id, location_code: 'A-01', lines: [{ po_line_id: po.lines[0].po_line_id, qty: 1, lot_code: 'X' }] }),
    isCode('conflict'),
  );
  const c = await call(a, 'po_status_set', { po_id: po.po_id, status: 'cancelled', note: 'Supplier could not deliver in time.' });
  assert.equal(c.status, 'cancelled');
  await assert.rejects(call(a, 'po_status_set', { po_id: po.po_id, status: 'sent', note: 'oops' }), isCode('conflict'));
});
