// End to end against the teammate's supplier server running locally (docker compose, fictional
// Northbeck Metalworks) and real NEAR testnet. Opt-in: `npm run test:e2e`. Needs:
//   - the demo server on http://127.0.0.1:8790 (docker compose up in supplier-inventory-mcp)
//   - demo keys in ~/.config/near-payment-mcp/local-demo-keys.txt (or SUPPLY_OWNER_KEY / SUPPLY_BUYER_KEY)
//   - PAYER_ACCOUNT / PAYER_PRIVATE_KEY in .env.local, with >= 1 testnet USDC
//   - RECEIVER_ACCOUNT: an existing testnet account that you control
// Spends 0.50 USDC per run. The owner key acts as the human approver; the payment side signs in
// with the buyer key (read+write, no approve), exactly as the payment MCP does.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { Ledger } from '../../src/ledger.ts';
import { Payments } from '../../src/pay.ts';
import type { PolicyConfig } from '../../src/policy.ts';
import { PublicNearRail } from '../../src/rails/public-near.ts';
import type { SupplyClient } from '../../src/supply/client.ts';
import { BUYER, OWNER, clientFor, demoPos } from './demo.ts';
import { KeyPair } from 'near-api-js';

const RECEIVER = process.env.RECEIVER_ACCOUNT ?? '';
const RPC = loadConfig({ ...process.env, NEAR_NETWORK: 'testnet' }).rpcUrl;
const enabled = process.env.E2E === '1';
const runId = Date.now().toString(36);

let dir: string;
let owner: SupplyClient; // human approver
let payments: Payments;
let rail: PublicNearRail;
let policy: PolicyConfig;
let pos: ReturnType<typeof demoPos>;
const setPayout = (account: string, token = 'usdc') => pos.setPayout(account, token);
const approvedPo = (qty: string, price: string, approve = true) => pos.approvedPo(qty, price, approve);

async function chainBalance(account: string): Promise<bigint> {
  return new PublicNearRail({ network: 'testnet', rpcUrl: RPC, payerAccountId: account, payerKey: KeyPair.fromRandom('ed25519').toString() as never }) // read-only: never signs
    .balance(policy.tokens.usdc!);
}

before(async () => {
  if (!enabled) return;
  if (!RECEIVER || !RECEIVER.endsWith('.testnet')) throw new Error('Set RECEIVER_ACCOUNT to a testnet account you control.');
  const cfg = loadConfig({ ...process.env, NEAR_NETWORK: 'testnet' });
  if (!cfg.payer) throw new Error('PAYER_ACCOUNT / PAYER_PRIVATE_KEY missing');
  dir = mkdtempSync(path.join(os.tmpdir(), 'pay-e2e-'));
  owner = await clientFor(dir, OWNER, 'read write approve');
  const buyer = await clientFor(dir, BUYER, 'read write');
  const me = await buyer.call<{ scopes: string[] }>('whoami', {}, { reason: 'e2e: check payment session' });
  assert.deepEqual(me.scopes.sort(), ['read', 'write'], 'payment session must not hold approve');
  pos = demoPos(owner, runId);
  await pos.init();
  rail = new PublicNearRail({ network: 'testnet', rpcUrl: RPC, payerAccountId: cfg.payer.accountId, payerKey: cfg.payer.key });
  policy = { ...cfg.policy, perPaymentCap: '1', dailyCap: '5' };
  payments = new Payments({ supply: buyer, ledger: new Ledger(path.join(dir, 'ledger.db')), rail, policy, settleTimeoutMs: 60_000 });
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('pays an approved PO on testnet and records the same tx on the PO', { skip: !enabled }, async () => {
  await setPayout(RECEIVER);
  const po = await approvedPo('1', '0.50');
  const before = await chainBalance(RECEIVER);

  const preview = await payments.preview(po.po_id);
  assert.equal(preview.would_pay, true, preview.reasons.join(' '));

  const r = await payments.pay(po.po_id);
  assert.equal(r.outcome, 'paid', JSON.stringify(r));

  // chain: the tx we hashed before broadcast is final, from the payer, to the receiver, for 0.50 USDC
  const tx = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tx', params: { tx_hash: r.tx_ref, sender_account_id: rail['payer'], wait_until: 'FINAL' } }) })).json() as any;
  assert.equal(tx.result.transaction.hash, r.tx_ref);
  assert.ok('SuccessValue' in tx.result.status);
  const args = JSON.parse(Buffer.from(tx.result.transaction.actions[0].FunctionCall.args, 'base64').toString());
  assert.deepEqual(args, { receiver_id: RECEIVER, amount: '500000', memo: `PO ${po.po_code}` });
  assert.equal((await chainBalance(RECEIVER)) - before, 500_000n);

  // supplier server: PO recorded paid with the same hash
  const live = await owner.call<any>('po_get', { po_id: po.po_id }, { reason: 'e2e: check PO' });
  assert.equal(live.payment_status, 'paid');
  assert.equal(live.payment_ref, r.tx_ref);

  // paying again is refused and moves nothing
  const again = await payments.pay(po.po_id);
  assert.equal(again.outcome, 'not_instructed');
  assert.equal((await chainBalance(RECEIVER)) - before, 500_000n);
});

const refusals: [string, () => Promise<void>, string, RegExp][] = [
  ['above our per-payment cap', async () => setPayout(RECEIVER), '1.50', /per-payment cap/],
  ['payout account does not exist', async () => setPayout(`nobody-${runId}.testnet`), '0.10', /does not exist/],
  ['mainnet account on the testnet rail', async () => setPayout('mill-direct.near'), '0.10', /not a testnet account/],
  ['token not on the allowlist', async () => setPayout(RECEIVER, 'usdt'), '0.10', /allowlist/],
];
for (const [name, arrange, amount, reason] of refusals) {
  test(`refused, nothing sent: ${name}`, { skip: !enabled }, async () => {
    await arrange();
    const po = await approvedPo('1', amount);
    const payerBefore = await rail.balance(policy.tokens.usdc!);
    const r = await payments.pay(po.po_id);
    assert.equal(r.outcome, 'refused', JSON.stringify(r));
    assert.match(r.reasons!.join(' '), reason);
    assert.equal(r.tx_ref, null);
    assert.equal(await rail.balance(policy.tokens.usdc!), payerBefore);
    const live = await owner.call<any>('po_get', { po_id: po.po_id }, { reason: 'e2e: check PO' });
    assert.equal(live.payment_status, 'failed');
    assert.match(live.status_note ?? '', reason);
  });
}

test('unapproved PO: the supplier server refuses to instruct', { skip: !enabled }, async () => {
  await setPayout(RECEIVER);
  const po = await approvedPo('1', '0.10', false);
  const r = await payments.pay(po.po_id);
  assert.equal(r.outcome, 'not_instructed');
  assert.match(r.reasons!.join(' '), /not approved/);
  const live = await owner.call<any>('po_get', { po_id: po.po_id }, { reason: 'e2e: check PO' });
  assert.equal(live.payment_status, 'unpaid');
});
