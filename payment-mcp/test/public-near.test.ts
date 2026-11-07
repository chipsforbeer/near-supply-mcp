// PublicNearRail against a scripted JSON-RPC, focused on the one decision that can cause a double
// payment: when a tx is declared "dropped".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, SignedTransaction, Signature, actions, baseEncode, createTransaction } from 'near-api-js';
import { PublicNearRail } from '../src/rails/public-near.ts';

const kp = KeyPair.fromRandom('ed25519');
const REF_HASH = new Uint8Array(32).fill(7);

function payload(): string {
  const tx = createTransaction('payer.testnet', kp.getPublicKey(), 'usdc.testnet', 1n, [actions.transfer(1n)], REF_HASH);
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: 0, data: new Uint8Array(64) }) });
  return Buffer.from(signed.encode()).toString('base64');
}

type Handler = (method: string, params: any) => { result?: unknown; error?: unknown } | 'http429' | 'garbage';
function rail(handler: Handler) {
  const calls: string[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body));
    calls.push(method);
    const r = handler(method, params);
    if (r === 'http429') return new Response('slow down', { status: 429 });
    if (r === 'garbage') return new Response('<html>oops</html>', { status: 200 });
    return Response.json({ jsonrpc: '2.0', id: 'pay', ...r });
  }) as typeof fetch;
  return { calls, r: new PublicNearRail({ network: 'testnet', rpcUrl: 'http://rpc.test', payerAccountId: 'payer.testnet', payerKey: kp.toString() as never, fetchFn }) };
}
const unknownTx = { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } } };
const unknownBlock = { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_BLOCK' } } };
const genesis = { result: { transaction_validity_period: 86400 } };
const block = (height: number) => ({ result: { header: { height } } });

test('regression: unknown tx + reference block not found on this RPC node = pending, never dropped', async () => {
  const { r } = rail((m) => (m === 'tx' ? unknownTx : m === 'block' ? unknownBlock : genesis));
  assert.deepEqual(await r.status('h', payload()), { state: 'pending' });
});

test('unknown tx, reference block recent = pending', async () => {
  const { r } = rail((m, p) => (m === 'tx' ? unknownTx : m === 'block' ? (p.block_id ? block(1000) : block(1010)) : genesis));
  assert.deepEqual(await r.status('h', payload()), { state: 'pending' });
});

test('unknown tx, reference block provably past the validity window = dropped', async () => {
  const { r } = rail((m, p) => {
    if (m === 'tx') return unknownTx;
    if (m === 'block') {
      if (p.block_id) { assert.equal(p.block_id, baseEncode(REF_HASH)); return block(1000); }
      return block(1000 + 86400 + 101);
    }
    return genesis;
  });
  assert.deepEqual(await r.status('h', payload()), { state: 'dropped' });
});

test('unknown tx, no payload to check expiry = pending', async () => {
  const { r } = rail(() => unknownTx);
  assert.deepEqual(await r.status('h', null), { state: 'pending' });
});

test('final success / final failure / not yet final', async () => {
  const ok = rail(() => ({ result: { final_execution_status: 'FINAL', status: { SuccessValue: '' } } })).r;
  assert.deepEqual(await ok.status('h', null), { state: 'success' });
  const bad = rail(() => ({ result: { final_execution_status: 'FINAL', status: { Failure: { ActionError: 'x' } } } })).r;
  assert.equal((await bad.status('h', null)).state, 'failed');
  const soon = rail(() => ({ result: { final_execution_status: 'EXECUTED_OPTIMISTIC', status: { SuccessValue: '' } } })).r;
  assert.deepEqual(await soon.status('h', null), { state: 'pending' });
});

test('transport errors are retried (429, non-JSON), then succeed', async () => {
  let n = 0;
  const { r, calls } = rail(() => (++n === 1 ? 'http429' : n === 2 ? 'garbage' : { result: { final_execution_status: 'FINAL', status: { SuccessValue: '' } } }));
  assert.deepEqual(await r.status('h', null), { state: 'success' });
  assert.equal(calls.length, 3);
});

test('a persistently unreachable RPC throws (the attempt stays open), it does not guess', async () => {
  const { r } = rail(() => 'http429');
  await assert.rejects(r.status('h', null), /unreachable/);
});

test('receiver that does not exist is refused; storage is not registered for it', async () => {
  const { r, calls } = rail((m, p) => (m === 'query' && p.request_type === 'view_account' ? { error: { cause: { name: 'UNKNOWN_ACCOUNT' } } } : { result: {} }));
  const reason = await r.ensureReceiver({ poId: 'x', poCode: 'PO-1', receiver: 'nobody.testnet', token: { contract: 'usdc.testnet', decimals: 6, currency: 'USD' }, units: 1n });
  assert.match(reason!, /does not exist/);
  assert.deepEqual(calls, ['query']); // no storage_deposit, nothing sent
});
