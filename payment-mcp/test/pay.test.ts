import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.ts';
import { Payments } from '../src/pay.ts';
import type { PolicyConfig } from '../src/policy.ts';
import type { CallOptions, SupplyApi } from '../src/supply/client.ts';
import { FakeRail, FakeSupply, PO_ID } from './helpers/fakes.ts';

const policy: PolicyConfig = {
  network: 'testnet',
  tokens: { usdc: { contract: 'usdc.example.testnet', decimals: 6, currency: 'USD' } },
  perPaymentCap: '5000',
  dailyCap: '10000',
};

function setup() {
  const supply = new FakeSupply();
  const rail = new FakeRail();
  const ledger = new Ledger(':memory:');
  const payments = new Payments({ supply, rail, ledger, policy, settleTimeoutMs: 0, pollMs: 0, sleep: async () => {} });
  return { supply, rail, ledger, payments };
}

test('happy path: instruction fetched by the MCP, paid once, recorded on the PO', async () => {
  const { supply, rail, payments } = setup();
  const r = await payments.pay(PO_ID);
  assert.equal(r.outcome, 'paid');
  assert.equal(rail.sent.length, 1);
  assert.equal(rail.sent[0]!.receiver, 'mill-direct.testnet');
  assert.equal(rail.sent[0]!.units, 4_237_200_000n);
  assert.deepEqual(rail.ensured, ['mill-direct.testnet']);
  assert.equal(supply.po.payment_status, 'paid');
  assert.equal(supply.po.payment_ref, r.tx_ref);
  assert.match(supply.po.payment_note!, /nearblocks/);
  // every write carried a deterministic request_key
  assert.deepEqual(supply.calls.filter((c) => c.key).map((c) => c.key), [`pay:${PO_ID}:1`, `rec:${PO_ID}:1`]);
});

test('paying again is refused by the server and sends nothing', async () => {
  const { rail, payments } = setup();
  await payments.pay(PO_ID);
  const again = await payments.pay(PO_ID);
  assert.equal(again.outcome, 'not_instructed');
  assert.match(again.reasons!.join(), /already paid/);
  assert.equal(rail.sent.length, 1);
});

test('overlapping pay calls for the same PO transfer only once', async () => {
  const { rail, payments, ledger } = setup();
  try {
    const results = await Promise.all([payments.pay(PO_ID), payments.pay(PO_ID)]);
    assert.deepEqual(results.map((r) => r.outcome), ['paid', 'not_instructed']);
    assert.equal(rail.sent.length, 1);
  } finally {
    ledger.close();
  }
});

test('overlapping POs cannot both spend the same remaining daily allowance', async () => {
  const first = new FakeSupply();
  const second = new FakeSupply();
  const secondId = '22222222-2222-4222-8222-222222222222';
  second.po.po_id = secondId;
  second.po.po_code = 'PO-0002';
  const supply: SupplyApi = {
    call<T>(op: string, args: Record<string, unknown>, opts: CallOptions): Promise<T> {
      return (args.po_id === secondId ? second : first).call<T>(op, args, opts);
    },
  };
  const rail = new FakeRail();
  const ledger = new Ledger(':memory:');
  const payments = new Payments({ supply, rail, ledger, policy: { ...policy, dailyCap: '5000' }, settleTimeoutMs: 0 });
  try {
    const results = await Promise.all([payments.pay(PO_ID), payments.pay(secondId)]);
    assert.deepEqual(results.map((r) => r.outcome), ['paid', 'refused']);
    assert.match(results[1]!.reasons!.join(' '), /daily cap/);
    assert.equal(rail.sent.length, 1);
    assert.equal(second.po.payment_status, 'failed');
  } finally {
    ledger.close();
  }
});

test('a failed queued call does not block an overlapping retry', async () => {
  const { supply, rail, payments, ledger } = setup();
  supply.loseResponse.po_payment_instruction = 1;
  try {
    const results = await Promise.allSettled([payments.pay(PO_ID), payments.pay(PO_ID)]);
    assert.equal(results[0]!.status, 'rejected');
    const retry = results[1]!;
    assert.equal(retry.status, 'fulfilled');
    if (retry.status === 'fulfilled') assert.equal(retry.value.outcome, 'paid');
    assert.equal(rail.sent.length, 1);
  } finally {
    ledger.close();
  }
});

test('reconciliation and an overlapping pay call share the same serialization guard', async () => {
  const { rail, payments, ledger } = setup();
  rail.dropNextBroadcast = true;
  try {
    assert.equal((await payments.pay(PO_ID)).outcome, 'pending');
    const [reconciled, payment] = await Promise.all([payments.reconcile(), payments.pay(PO_ID)]);
    assert.equal(reconciled[0]!.outcome, 'paid');
    assert.equal(payment.outcome, 'not_instructed');
    assert.equal(rail.sent.length, 1);
  } finally {
    ledger.close();
  }
});

test('lost instruction response: retry replays the cached instruction, pays once', async () => {
  const { supply, rail, payments } = setup();
  supply.loseResponse.po_payment_instruction = 1;
  await assert.rejects(payments.pay(PO_ID), /response lost/);
  assert.equal(supply.po.payment_status, 'instructed'); // server already opened it
  const r = await payments.pay(PO_ID);
  assert.equal(r.outcome, 'paid');
  assert.equal(r.attempt, 1);
  assert.equal(rail.sent.length, 1);
});

test('lost record response after payment: retry records, never re-pays', async () => {
  const { supply, rail, ledger, payments } = setup();
  supply.loseResponse.po_payment_record = 1;
  await assert.rejects(payments.pay(PO_ID), /response lost/);
  assert.equal(ledger.latest(PO_ID)!.state, 'settled_ok');
  const r = await payments.pay(PO_ID);
  assert.equal(r.outcome, 'paid');
  assert.equal(rail.sent.length, 1);
  assert.equal(supply.po.payment_status, 'paid');
});

test('record outage: reconcile finishes it later', async () => {
  const { supply, rail, payments } = setup();
  supply.loseResponse.po_payment_record = 1;
  await assert.rejects(payments.pay(PO_ID));
  const [r] = await payments.reconcile();
  assert.equal(r!.outcome, 'paid');
  assert.equal(rail.sent.length, 1);
  assert.equal(supply.po.payment_status, 'paid');
});

test('broadcast timeout but tx landed: the chain check settles it as paid, once', async () => {
  const { supply, rail, payments } = setup();
  rail.loseBroadcastResponse = true;
  const r = await payments.pay(PO_ID);
  assert.equal(r.outcome, 'paid');
  assert.equal(supply.po.payment_status, 'paid');
  assert.equal(rail.sent.length, 1);
});

test('broadcast failed: reconcile re-sends the SAME signed tx, which lands once', async () => {
  const { rail, payments } = setup();
  rail.dropNextBroadcast = true;
  assert.equal((await payments.pay(PO_ID)).outcome, 'pending');
  const [r] = await payments.reconcile();
  assert.equal(r!.outcome, 'paid');
  assert.equal(r!.tx_ref, 'faketx-1'); // never re-signed
  assert.equal(rail.sent.length, 1);
});

test('crash between signing and broadcast: resume broadcasts the persisted tx', async () => {
  const { rail, ledger, payments } = setup();
  const realBroadcast = rail.broadcast.bind(rail);
  rail.broadcast = async () => { throw new TypeError('process died'); }; // simulate dying right after 'signed'
  rail.status = async () => ({ state: 'pending' });
  assert.equal((await payments.pay(PO_ID)).outcome, 'pending');
  assert.equal(ledger.latest(PO_ID)!.state, 'signed');
  rail.broadcast = realBroadcast;
  rail.status = FakeRail.prototype.status.bind(rail);
  const r = await payments.pay(PO_ID);
  assert.equal(r.outcome, 'paid');
  assert.equal(r.tx_ref, 'faketx-1');
  assert.equal(rail.sent.length, 1);
});

test('broadcast never landed and expired: recorded failed, then a new attempt pays', async () => {
  const { supply, rail, payments } = setup();
  rail.dropNextBroadcast = true;
  rail.expired = true;
  assert.equal((await payments.pay(PO_ID)).outcome, 'failed');
  assert.equal(supply.po.payment_status, 'failed');
  rail.expired = false;
  const retry = await payments.pay(PO_ID);
  assert.equal(retry.outcome, 'paid');
  assert.equal(retry.attempt, 2);
  assert.equal(rail.sent.length, 1);
});

test('slow finality: pending, then paid', async () => {
  const { rail, payments } = setup();
  rail.pendingPolls = 1;
  assert.equal((await payments.pay(PO_ID)).outcome, 'pending');
  assert.equal((await payments.pay(PO_ID)).outcome, 'paid'); // pay() resumes the open attempt
  assert.equal(rail.sent.length, 1);
});

test('tx failed on chain: recorded failed', async () => {
  const { supply, rail, payments } = setup();
  rail.failOnChain = true;
  const r = await payments.pay(PO_ID);
  assert.equal(r.outcome, 'failed');
  assert.equal(supply.po.payment_status, 'failed');
  assert.match(supply.po.payment_note!, /insufficient balance/);
});

test('policy refusal: nothing sent, PO marked failed with the reason; fixable and retryable', async () => {
  const { supply, rail, payments } = setup();
  supply.payout!.token = 'usdt'; // not on our allowlist
  const r = await payments.pay(PO_ID);
  assert.equal(r.outcome, 'refused');
  assert.match(r.reasons!.join(), /allowlist/);
  assert.equal(rail.sent.length, 0);
  assert.equal(supply.po.payment_status, 'failed');
  assert.match(supply.po.payment_ref!, /^refused:/);
  supply.payout!.token = 'usdc'; // approver fixes the payout account
  assert.equal((await payments.pay(PO_ID)).outcome, 'paid');
  assert.equal(rail.sent.length, 1);
});

test('receiver not ready (e.g. account does not exist): refused before signing', async () => {
  const { supply, rail, payments } = setup();
  rail.receiverProblem = 'mill-direct.testnet does not exist on testnet; tokens sent there would be lost.';
  const r = await payments.pay(PO_ID);
  assert.equal(r.outcome, 'refused');
  assert.equal(rail.broadcasts, 0);
  assert.match(supply.po.payment_note!, /does not exist/);
});

test('mainnet account on the testnet rail is refused', async () => {
  const { supply, rail, payments } = setup();
  supply.payout!.account_id = 'mill-direct.near';
  const r = await payments.pay(PO_ID);
  assert.equal(r.outcome, 'refused');
  assert.equal(rail.sent.length, 0);
});

test('payer balance too low is refused before signing', async () => {
  const { rail, payments } = setup();
  rail.balanceUnits = 1n;
  const r = await payments.pay(PO_ID);
  assert.equal(r.outcome, 'refused');
  assert.match(r.reasons!.join(), /balance/);
});

test('daily cap counts what was already paid today', async () => {
  const { supply, rail, payments } = setup();
  await payments.pay(PO_ID); // 4237.2
  supply.po.payment_status = 'unpaid'; // pretend a second PO of the same size, twice more
  assert.equal((await payments.pay(PO_ID)).outcome, 'paid'); // 8474.4 total
  supply.po.payment_status = 'unpaid';
  const third = await payments.pay(PO_ID);
  assert.equal(third.outcome, 'refused');
  assert.match(third.reasons!.join(), /daily cap/);
  assert.equal(rail.sent.length, 2);
});

test('unapproved PO: server refuses to instruct, nothing left open anywhere', async () => {
  const { supply, rail, ledger, payments } = setup();
  supply.po.approved_at = null;
  const r = await payments.pay(PO_ID);
  assert.equal(r.outcome, 'not_instructed');
  assert.equal(supply.po.payment_status, 'unpaid');
  assert.equal(ledger.open().length, 0);
  assert.equal(rail.sent.length, 0);
});

test('stale instruction: PO no longer instructed on the server, so no money moves', async () => {
  const { supply, rail, ledger, payments } = setup();
  supply.loseResponse.po_payment_instruction = 1;
  await assert.rejects(payments.pay(PO_ID));
  supply.po.payment_status = 'paid'; // someone else settled it meanwhile
  supply.po.payment_ref = 'elsewhere';
  // The cached instruction replays, but the live po_get check stops it.
  const r = await payments.pay(PO_ID);
  assert.equal(r.outcome, 'not_instructed');
  assert.equal(rail.sent.length, 0);
  assert.equal(ledger.latest(PO_ID)!.state, 'aborted');
});

test('reconcile leaves not-yet-signed attempts alone', async () => {
  const { supply, rail, payments } = setup();
  supply.loseResponse.po_payment_instruction = 1;
  await assert.rejects(payments.pay(PO_ID));
  assert.deepEqual(await payments.reconcile(), []);
  assert.equal(rail.sent.length, 0);
});

test('preview changes nothing', async () => {
  const { supply, rail, ledger, payments } = setup();
  const p = await payments.preview(PO_ID);
  assert.equal(p.would_pay, true, p.reasons.join());
  assert.equal(supply.po.payment_status, 'unpaid');
  assert.equal(supply.calls.filter((c) => c.key).length, 0);
  assert.equal(ledger.open().length, 0);
  assert.equal(rail.sent.length, 0);
  supply.payout!.account_id = 'mill-direct.near';
  assert.match((await payments.preview(PO_ID)).reasons.join(), /mainnet account/);
});

test('an attempt signed on another rail is not re-sent or re-checked by this one', async () => {
  const { rail, ledger, payments } = setup();
  const a = ledger.begin(PO_ID);
  ledger.update(a, 'signed', { rail: 'near-confidential-mainnet', tx_ref: 'intent-hash', tx_payload: '{"signed":"..."}' });
  await assert.rejects(payments.pay(PO_ID), /signed on rail near-confidential-mainnet; this server runs fake/);
  await assert.rejects(payments.reconcile(), /signed on rail near-confidential-mainnet/);
  assert.equal(rail.broadcasts, 0);
  const st = await payments.status(PO_ID);
  assert.equal(st.chain, null);
  assert.match(st.note!, /near-confidential-mainnet/);
});

test('payment_status never returns the signed payload', async () => {
  const { payments } = setup();
  await payments.pay(PO_ID);
  const st = await payments.status(PO_ID);
  assert.ok(st.attempts.length === 1 && !('tx_payload' in st.attempts[0]!));
});
