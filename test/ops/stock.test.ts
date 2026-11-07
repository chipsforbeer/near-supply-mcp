import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase, testDb } from '../helpers/db.ts';
import { newActor, call } from '../helpers/ops.ts';
import { setupSite, makeItem, solvent } from '../helpers/fixtures.ts';
import { OpError } from '../../src/ops/errors.ts';
import { withCompany } from '../../src/db/pool.ts';

before(resetTestDatabase);
const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;
const at = { site_code: 'MAIN', location_code: 'A-01' };

async function level(actor: any, itemId: string, loc = 'A-01'): Promise<number> {
  const r = await call(actor, 'stock_levels', { item_id: itemId, include_zero: true });
  return Number(r.items.find((i: any) => i.location_code === loc)?.qty_base ?? 0);
}

test('receipt in packs, issue in base units, display in packs', async () => {
  const a = await newActor();
  await setupSite(a);
  const ipa = await solvent(a);
  const rec = await call(a, 'stock_move', { item_id: ipa.id, type: 'receipt', qty: 4, pack: '200 L drum', ...at });
  assert.equal(rec.qty_base, '800');
  await call(a, 'stock_move', { item_id: ipa.id, type: 'issue', qty: 80, uom: 'L', ...at, note: 'line cleaning' });
  const levels = await call(a, 'stock_levels', { item_id: ipa.id });
  assert.equal(levels.items[0].display, '3 x 200 L drum + 120 L');
  const history = await call(a, 'stock_history', { item_id: ipa.id });
  const receipt = history.txns.find((t: any) => t.txn_type === 'receipt');
  assert.equal(Number(receipt.entered_qty), 4);
  assert.equal(receipt.entered_pack, '200 L drum');
  assert.equal(Number(receipt.qty_base), 800);
});

test('an issue beyond stock is refused and writes nothing', async () => {
  const a = await newActor();
  await setupSite(a);
  const ipa = await solvent(a);
  await call(a, 'stock_move', { item_id: ipa.id, type: 'receipt', qty: 50, ...at });
  await assert.rejects(call(a, 'stock_move', { item_id: ipa.id, type: 'issue', qty: 51, ...at }), isCode('conflict'));
  assert.equal(await level(a, ipa.id), 50);
  const history = await call(a, 'stock_history', { item_id: ipa.id });
  assert.equal(history.txns.length, 1);
});

test('counts write only the difference', async () => {
  const a = await newActor();
  await setupSite(a);
  const ipa = await solvent(a);
  await call(a, 'stock_move', { item_id: ipa.id, type: 'receipt', qty: 50, ...at });
  const c = await call(a, 'stock_count', { item_id: ipa.id, ...at, counted_qty: '62.5' });
  assert.equal(c.correction_base, '12.5');
  const same = await call(a, 'stock_count', { item_id: ipa.id, ...at, counted_qty: '62.5' });
  assert.equal(same.txn_id, null);
  assert.equal(await level(a, ipa.id), 62.5);
});

test('transfers move stock between locations and reverse as a pair', async () => {
  const a = await newActor();
  await setupSite(a);
  const ipa = await solvent(a);
  await call(a, 'stock_move', { item_id: ipa.id, type: 'receipt', qty: 100, ...at });
  const t = await call(a, 'stock_move', { item_id: ipa.id, type: 'transfer', qty: 30, ...at, to_location_code: 'B-01' });
  assert.equal(await level(a, ipa.id, 'A-01'), 70);
  assert.equal(await level(a, ipa.id, 'B-01'), 30);
  const rev = await call(a, 'stock_reverse', { txn_id: t.txns[0].txn_id, note: 'moved by mistake' });
  assert.equal(rev.reversals.length, 2);
  assert.equal(await level(a, ipa.id, 'A-01'), 100);
  assert.equal(await level(a, ipa.id, 'B-01'), 0);
  await assert.rejects(call(a, 'stock_reverse', { txn_id: t.txns[1].txn_id, note: 'again' }), isCode('conflict'));
});

test('reversals restore balances once and cannot be reversed', async () => {
  const a = await newActor();
  await setupSite(a);
  const ipa = await solvent(a);
  const r = await call(a, 'stock_move', { item_id: ipa.id, type: 'receipt', qty: 10, ...at });
  const rev = await call(a, 'stock_reverse', { txn_id: r.txns[0].txn_id, note: 'entered twice' });
  assert.equal(await level(a, ipa.id), 0);
  await assert.rejects(call(a, 'stock_reverse', { txn_id: r.txns[0].txn_id, note: 'x' }), isCode('conflict'));
  await assert.rejects(call(a, 'stock_reverse', { txn_id: rev.reversals[0].txn_id, note: 'x' }), isCode('invalid_arguments'));
});

test('lot-tracked items need lot codes; quarantine receipts land quarantined', async () => {
  const a = await newActor();
  await setupSite(a);
  const sheet = await makeItem(a, { sku: 'SS304', name: '304 sheet', physical_form: 'sheet', base_uom: 'kg', is_lot_tracked: true });
  await assert.rejects(call(a, 'stock_move', { item_id: sheet.id, type: 'receipt', qty: 708, ...at }), isCode('invalid_arguments'));
  await call(a, 'stock_move', { item_id: sheet.id, type: 'receipt', qty: 708, ...at, lot_code: 'HEAT-4471' });
  await call(a, 'stock_move', { item_id: sheet.id, type: 'receipt', qty: 354, site_code: 'MAIN', location_code: 'QC', lot_code: 'HEAT-4480' });
  const levels = await call(a, 'stock_levels', { item_id: sheet.id });
  const q = levels.items.find((i: any) => i.lot_code === 'HEAT-4480');
  assert.equal(q.lot_status, 'quarantine');
  assert.equal(q.usable, false);
  const ok = levels.items.find((i: any) => i.lot_code === 'HEAT-4471');
  assert.equal(ok.usable, true);
  const got = await call(a, 'item_get', { item_id: sheet.id });
  assert.equal(Number(got.stock[0].qty_base), 1062);
});

test('the ledger is append-only for the app role', async () => {
  const a = await newActor();
  await setupSite(a);
  const ipa = await solvent(a);
  await call(a, 'stock_move', { item_id: ipa.id, type: 'receipt', qty: 5, ...at });
  await assert.rejects(
    withCompany(testDb().app, a.session.companyId, (tx) => tx.query('UPDATE stock_txn SET qty_base = 1')),
    /permission denied/,
  );
  await assert.rejects(
    withCompany(testDb().app, a.session.companyId, (tx) => tx.query('DELETE FROM stock_txn')),
    /permission denied/,
  );
});

test('another company cannot move or see the stock', async () => {
  const a = await newActor();
  const b = await newActor();
  await setupSite(a);
  await setupSite(b);
  const ipa = await solvent(a);
  await call(a, 'stock_move', { item_id: ipa.id, type: 'receipt', qty: 5, ...at });
  await assert.rejects(call(b, 'stock_move', { item_id: ipa.id, type: 'issue', qty: 1, ...at }), isCode('not_found'));
  const seen = await call(b, 'stock_levels', {});
  assert.equal(seen.items.length, 0);
});
