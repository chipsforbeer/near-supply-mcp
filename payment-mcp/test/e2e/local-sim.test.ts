// End to end against the local demo supply server (`docker compose up` at the repo root: fictional
// Northbeck Metalworks) with the NEAR chain SIMULATED in memory, so it needs no NEAR account, key,
// funds or network beyond 127.0.0.1. Everything else is the real thing: OAuth sign-in with the demo
// keys, the owner approving, the payment side signed in without approve, the supply server's payment
// instruction and record, and this MCP's policy checks, ledger and payment state machine.
// The same flow on real NEAR testnet is local-demo.test.ts (`npm run test:e2e`).
//
// Opt-in: `npm run test:e2e:sim` (or `sh scripts/e2e-local.sh` at the repo root, which also starts the
// demo). Demo keys come from SUPPLY_OWNER_KEY / SUPPLY_BUYER_KEY or
// ~/.config/near-payment-mcp/local-demo-keys.txt (the lines as `docker compose logs app` printed them).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { Ledger } from '../../src/ledger.ts';
import { Payments } from '../../src/pay.ts';
import type { PolicyConfig, TokenConfig } from '../../src/policy.ts';
import type { PayRequest, Prepared, Rail, TxStatus } from '../../src/rails/rail.ts';
import { SupplyError, type SupplyClient } from '../../src/supply/client.ts';
import { BASE, BUYER, OWNER, clientFor, demoPos } from './demo.ts';

/** An in-memory NEAR testnet holding USDC balances. A signed transfer lands at most once (like a
 *  NEAR transaction, whose nonce is single-use), and only to an account that exists. */
class SimulatedChain implements Rail {
  readonly name = 'simulated-testnet';
  readonly network = 'testnet' as const;
  /** next broadcast lands, but its response is lost (the caller sees an error) */
  loseNextBroadcastResponse = false;
  private readonly payer: string;
  private readonly units = new Map<string, bigint>();
  private readonly txs = new Map<string, { req: PayRequest; landed: boolean }>();

  constructor(payer: string, balances: Record<string, bigint>) {
    this.payer = payer;
    for (const [account, units] of Object.entries(balances)) this.units.set(account, units);
  }

  unitsOf(account: string): bigint {
    return this.units.get(account) ?? 0n;
  }

  async balance(_token: TokenConfig) {
    return this.unitsOf(this.payer);
  }

  async ensureReceiver(req: PayRequest) {
    return this.units.has(req.receiver)
      ? null
      : `Payout account ${req.receiver} does not exist on NEAR testnet (simulated chain); tokens sent there would be lost.`;
  }

  async prepare(req: PayRequest): Promise<Prepared> {
    const ref = `sim-${randomUUID()}`;
    this.txs.set(ref, { req, landed: false });
    return { ref, payload: ref };
  }

  async broadcast(payload: string) {
    const tx = this.txs.get(payload);
    if (!tx) throw new Error('unknown transaction');
    if (!tx.landed) {
      if (this.unitsOf(this.payer) < tx.req.units) throw new Error('insufficient balance');
      tx.landed = true;
      this.units.set(this.payer, this.unitsOf(this.payer) - tx.req.units);
      this.units.set(tx.req.receiver, this.unitsOf(tx.req.receiver) + tx.req.units);
    }
    if (this.loseNextBroadcastResponse) {
      this.loseNextBroadcastResponse = false;
      throw new Error('timeout (simulated lost response)');
    }
  }

  async status(ref: string): Promise<TxStatus> {
    return this.txs.get(ref)?.landed ? { state: 'success' } : { state: 'pending' };
  }

  link(): string | null {
    return null;
  }
}

const enabled = process.env.E2E_SIM === '1';
const runId = Date.now().toString(36);
const PAYER = 'demo-payer.testnet';
const RECEIVER = 'example-fasteners.testnet'; // the demo supplier's payout account on the simulated chain

let dir: string;
let owner: SupplyClient; // the human approver (Northbeck owner key: read, write, approve)
let buyer: SupplyClient; // the payment MCP's own session (Northbeck buyer key: read, write)
let chain: SimulatedChain;
let payments: Payments;
let pos: ReturnType<typeof demoPos>;

const reason = { reason: 'e2e (simulated chain): check PO' };
const poGet = (poId: string) => owner.call<any>('po_get', { po_id: poId }, reason);

before(async () => {
  if (!enabled) return;
  const up = await fetch(new URL('/healthz', BASE)).then((r) => r.ok, () => false);
  if (!up) throw new Error(`No demo supply server at ${BASE}. Start it at the repo root with: docker compose up --build -d (or run sh scripts/e2e-local.sh, which does everything).`);
  dir = mkdtempSync(path.join(os.tmpdir(), 'pay-e2e-sim-'));
  owner = await clientFor(dir, OWNER, 'read write approve');
  buyer = await clientFor(dir, BUYER, 'read write');
  pos = demoPos(owner, `sim-${runId}`);
  await pos.init();
  chain = new SimulatedChain(PAYER, { [PAYER]: 20_000_000n, [RECEIVER]: 0n }); // payer holds 20 USDC
  const policy: PolicyConfig = { ...loadConfig({ NEAR_NETWORK: 'testnet' }).policy, perPaymentCap: '1', dailyCap: '5' };
  payments = new Payments({ supply: buyer, ledger: new Ledger(path.join(dir, 'ledger.db')), rail: chain, policy, settleTimeoutMs: 5_000, pollMs: 100 });
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('the payment side is signed in without approve, and cannot approve an order', { skip: !enabled }, async () => {
  const me = await buyer.call<{ scopes: string[] }>('whoami', {}, { reason: 'e2e (simulated chain): check payment session' });
  assert.deepEqual([...me.scopes].sort(), ['read', 'write']);
  const po = await pos.approvedPo('1', '0.10', false);
  await assert.rejects(
    buyer.call('po_approve', { po_id: po.po_id, approved_max_amount: '0.10' }, { reason: 'e2e (simulated chain): try to approve', requestKey: `sim-${runId}-buyer-approve` }),
    (e: unknown) => e instanceof SupplyError && e.code === 'forbidden',
  );
  assert.equal((await poGet(po.po_id)).approved_at, null);
});

test('pays an approved PO and records the same reference on it; paying again is refused', { skip: !enabled }, async () => {
  await pos.setPayout(RECEIVER);
  const po = await pos.approvedPo('1', '0.50');
  const before = { payer: chain.unitsOf(PAYER), receiver: chain.unitsOf(RECEIVER) };

  const preview = await payments.preview(po.po_id);
  assert.equal(preview.would_pay, true, preview.reasons.join(' '));
  assert.equal(preview.rail, 'simulated-testnet');

  const r = await payments.pay(po.po_id);
  assert.equal(r.outcome, 'paid', JSON.stringify(r));
  assert.match(r.tx_ref ?? '', /^sim-/);
  assert.equal(chain.unitsOf(RECEIVER) - before.receiver, 500_000n); // 0.50 USDC, 6 decimals
  assert.equal(before.payer - chain.unitsOf(PAYER), 500_000n);

  const live = await poGet(po.po_id);
  assert.equal(live.payment_status, 'paid');
  assert.equal(live.payment_ref, r.tx_ref);

  const again = await payments.pay(po.po_id);
  assert.equal(again.outcome, 'not_instructed');
  assert.match(again.reasons!.join(' '), /already paid/);
  assert.equal(chain.unitsOf(RECEIVER) - before.receiver, 500_000n);
});

test('a lost response after the transfer landed: recorded once, never paid twice', { skip: !enabled }, async () => {
  await pos.setPayout(RECEIVER);
  const po = await pos.approvedPo('1', '0.25');
  const before = chain.unitsOf(RECEIVER);
  chain.loseNextBroadcastResponse = true;

  const r = await payments.pay(po.po_id);
  assert.equal(r.outcome, 'paid', JSON.stringify(r));
  assert.equal(chain.unitsOf(RECEIVER) - before, 250_000n);
  assert.equal((await poGet(po.po_id)).payment_ref, r.tx_ref);

  assert.equal((await payments.pay(po.po_id)).outcome, 'not_instructed');
  assert.equal(chain.unitsOf(RECEIVER) - before, 250_000n);
});

const refusals: [string, () => Promise<unknown>, string, RegExp][] = [
  ['above our per-payment cap', () => pos.setPayout(RECEIVER), '1.50', /per-payment cap/],
  ['payout account does not exist', () => pos.setPayout(`nobody-${runId}.testnet`), '0.10', /does not exist/],
  ['mainnet account on the testnet rail', () => pos.setPayout('mill-direct.near'), '0.10', /not a testnet account/],
  ['token not on the allowlist', () => pos.setPayout(RECEIVER, 'usdt'), '0.10', /allowlist/],
];
for (const [name, arrange, amount, why] of refusals) {
  test(`refused, nothing sent: ${name}`, { skip: !enabled }, async () => {
    await arrange();
    const po = await pos.approvedPo('1', amount);
    const payerBefore = chain.unitsOf(PAYER);
    const r = await payments.pay(po.po_id);
    assert.equal(r.outcome, 'refused', JSON.stringify(r));
    assert.match(r.reasons!.join(' '), why);
    assert.equal(r.tx_ref, null);
    assert.equal(chain.unitsOf(PAYER), payerBefore);
    const live = await poGet(po.po_id);
    assert.equal(live.payment_status, 'failed');
    assert.match(live.status_note ?? '', why);
  });
}

test('unapproved PO: the supply server refuses to instruct, nothing is sent', { skip: !enabled }, async () => {
  await pos.setPayout(RECEIVER);
  const po = await pos.approvedPo('1', '0.10', false);
  const payerBefore = chain.unitsOf(PAYER);
  const r = await payments.pay(po.po_id);
  assert.equal(r.outcome, 'not_instructed');
  assert.match(r.reasons!.join(' '), /not approved/);
  assert.equal(chain.unitsOf(PAYER), payerBefore);
  assert.equal((await poGet(po.po_id)).payment_status, 'unpaid');
});
