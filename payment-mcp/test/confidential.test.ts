// ConfidentialRail and the NEAR Intents plumbing, against a scripted 1Click API and NEAR RPC.
// Focus: we sign only the exact transfer we meant, the intent hash is known before submitting, and a
// payment is declared "dropped" only when it provably can no longer execute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, baseDecode } from 'near-api-js';
import { ConfidentialRail, PRIVATE_TREASURY, type ConfidentialPayload } from '../src/rails/confidential.ts';
import { OneClick, intentHash, nep413Hash, versionedNonce, type Nep413Payload } from '../src/rails/intents.ts';
import { NearRpc } from '../src/rails/near-rpc.ts';
import type { PayRequest } from '../src/rails/rail.ts';

const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const IMT = `imt:${PRIVATE_TREASURY}:nep141:${USDC}`;
const PAYER = 'payer.near';
const DEP = 'aa'.repeat(32);
const NOW = Date.parse('2026-11-04T10:00:00Z');
const DEADLINE = '2026-11-07T10:00:00.000Z';
const kp = KeyPair.fromRandom('ed25519');
const token = { contract: USDC, decimals: 6, currency: 'USD' };
const req: PayRequest = { poId: 'po', poCode: 'PO-1', receiver: 'mill.near', token, units: 500_000n };

// Synthetic NEP-413 vector. Expected hash computed independently from the Borsh layout
// and SHA-256, not captured from a payment or calculated by the implementation under test.
test('NEP-413 hash matches a synthetic serialization vector', () => {
  const p: Nep413Payload = {
    message: JSON.stringify({
      deadline: '2030-01-01T00:00:00.000Z',
      intents: [{ intent: 'transfer', receiver_id: 'ab'.repeat(32), tokens: { [`nep141:${USDC}`]: '1000000' } }],
      signer_id: 'example-payer.near',
    }),
    nonce: Buffer.alloc(32, 7).toString('base64'),
    recipient: 'intents.near',
  };
  assert.equal(intentHash(p), '5YoqrgWhymYZZrVFu9AbNEKRT1ciCwCW66KGkhDZTKpH');
});

test('versioned nonce layout: magic, version 0, salt, deadline, start time, random', () => {
  const n = Buffer.from(versionedNonce(Buffer.from('e110f317', 'hex'), new Date(NOW + 300_000), new Date(NOW), new Uint8Array(7).fill(9)), 'base64');
  assert.equal(n.length, 32);
  assert.equal(n.subarray(0, 5).toString('hex'), '5628f6c600');
  assert.equal(n.subarray(5, 9).toString('hex'), 'e110f317');
  assert.equal(n.readBigUInt64LE(9), BigInt(NOW + 300_000) * 1_000_000n);
  assert.equal(n.readBigUInt64LE(17), BigInt(NOW) * 1_000_000n);
  assert.deepEqual([...n.subarray(25)], [9, 9, 9, 9, 9, 9, 9]);
});

// ---- scripted services ---------------------------------------------------------------------------

type Call = { path: string; body: any; headers: Record<string, string> };
type Script = {
  quote?: (body: any) => any;
  intent?: () => Nep413Payload;
  submit?: () => { status?: number; body: any };
  status?: () => { status?: number; body: any };
  balances?: any;
  accounts?: Record<string, boolean>;
};

const goodIntent = (over: { tokens?: any; receiver?: string; recipient?: string; signer?: string; deadline?: string; extra?: object; intents?: any[] } = {}): Nep413Payload => ({
  recipient: over.recipient ?? 'intents.far',
  nonce: Buffer.alloc(32, 1).toString('base64'),
  message: JSON.stringify({
    deadline: over.deadline ?? DEADLINE,
    intents: over.intents ?? [{ intent: 'transfer', receiver_id: over.receiver ?? DEP, tokens: over.tokens ?? { [IMT]: '500000' }, ...over.extra }],
    signer_id: over.signer ?? PAYER,
  }),
});
const goodQuote = (b: any) => ({
  quote: { depositAddress: DEP, amountIn: b.amount, amountOut: b.amount, minAmountOut: b.amount, deadline: DEADLINE },
  quoteRequest: { ...b },
});

function setup(s: Script = {}, now = NOW) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.host === 'rpc.test') {
      const { params } = JSON.parse(String(init.body));
      if (params.request_type === 'view_account') {
        return Response.json(s.accounts?.[params.account_id] === false ? { error: { cause: { name: 'UNKNOWN_ACCOUNT' } } } : { result: {} });
      }
      if (params.method_name === 'current_salt') return Response.json({ result: { result: [...Buffer.from(JSON.stringify('e110f317'))] } });
      throw new Error(`unexpected rpc ${JSON.stringify(params)}`);
    }
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: u.pathname, body, headers: init.headers as Record<string, string> });
    const reply = (r: { status?: number; body: any }) => new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    switch (u.pathname) {
      case '/v0/quote': return Response.json((s.quote ?? goodQuote)(body), { status: 201 });
      case '/v0/generate-intent': return Response.json({ intent: { standard: 'nep413', payload: (s.intent ?? goodIntent)() } }, { status: 201 });
      case '/v0/submit-intent': return reply(s.submit?.() ?? { status: 201, body: {} });
      case '/v0/status': return reply(s.status?.() ?? { body: { status: 'SUCCESS' } });
      case '/v0/auth/authenticate': return Response.json({ accessToken: 'user-session', expiresIn: 900, refreshToken: 'r' }, { status: 201 });
      case '/v0/account/balances': return Response.json({ balances: s.balances ?? [] });
    }
    throw new Error(`unexpected ${u.pathname}`);
  }) as typeof fetch;
  const api = new OneClick({ apiKey: 'partner-key', baseUrl: 'http://1click.test', fetchFn });
  const rail = new ConfidentialRail({ payerAccountId: PAYER, payerKey: kp.toString() as never, api, rpc: new NearRpc('http://rpc.test', fetchFn), now: () => now });
  return { rail, calls, paths: () => calls.map((c) => c.path) };
}

// ---- prepare: sign only what we meant ------------------------------------------------------------

test('prepare: confidential→confidential quote for the exact amount, verified intent, hash known before submit', async () => {
  const { rail, calls, paths } = setup();
  const p = await rail.prepare(req);
  const q = calls[0]!.body;
  assert.equal(q.dry, false);
  assert.deepEqual(
    [q.depositType, q.recipientType, q.refundType, q.recipient, q.refundTo, q.amount, q.originAsset, q.destinationAsset, q.slippageTolerance],
    ['CONFIDENTIAL_INTENTS', 'CONFIDENTIAL_INTENTS', 'CONFIDENTIAL_INTENTS', 'mill.near', PAYER, '500000', `nep141:${USDC}`, `nep141:${USDC}`, 0],
  );
  assert.equal(calls[0]!.headers['X-API-Key'], 'partner-key');
  assert.deepEqual(calls[1]!.body, { type: 'swap_transfer', standard: 'nep413', signerId: PAYER, depositAddress: DEP });
  assert.deepEqual(paths(), ['/v0/quote', '/v0/generate-intent']); // nothing submitted yet
  const payload = JSON.parse(p.payload) as ConfidentialPayload;
  assert.equal(p.ref, intentHash(payload.signed.payload));
  assert.equal(payload.depositAddress, DEP);
  assert.equal(payload.deadline, DEADLINE);
  assert.ok(kp.getPublicKey().verify(nep413Hash(payload.signed.payload), baseDecode(payload.signed.signature.slice('ed25519:'.length))));
});

const tampered: [string, Script][] = [
  ['public contract instead of intents.far', { intent: () => goodIntent({ recipient: 'intents.near' }) }],
  ['plain token instead of the confidential one', { intent: () => goodIntent({ tokens: { [`nep141:${USDC}`]: '500000' } }) }],
  ['confidential token of another treasury', { intent: () => goodIntent({ tokens: { [`imt:${'bb'.repeat(32)}:nep141:${USDC}`]: '500000' } }) }],
  ['more than the amount', { intent: () => goodIntent({ tokens: { [IMT]: '500001' } }) }],
  ['a second token', { intent: () => goodIntent({ tokens: { [IMT]: '500000', 'nep141:wrap.near': '1' } }) }],
  ['another receiver', { intent: () => goodIntent({ receiver: 'attacker.near' }) }],
  ['another signer', { intent: () => goodIntent({ signer: 'someone.near' }) }],
  ['a past deadline', { intent: () => goodIntent({ deadline: '2026-11-04T09:00:00.000Z' }) }],
  ['an extra intent', { intent: () => goodIntent({ intents: [JSON.parse(goodIntent().message).intents[0], { intent: 'add_public_key', public_key: 'ed25519:x' }] }) }],
  ['an extra field on the transfer', { intent: () => goodIntent({ extra: { msg: 'call something' } }) }],
  ['a quote that takes a fee', { quote: (b) => ({ quote: { depositAddress: DEP, amountIn: b.amount, amountOut: '499000', minAmountOut: '499000' } }) }],
  ['a quote for another recipient', { quote: (b) => ({ ...goodQuote(b), quoteRequest: { ...b, recipient: 'attacker.near' } }) }],
  ['a quote without deposit address', { quote: (b) => ({ quote: { amountIn: b.amount, amountOut: b.amount, minAmountOut: b.amount } }) }],
];
for (const [what, script] of tampered) {
  test(`prepare refuses to sign ${what}`, async () => {
    const { rail, paths } = setup(script);
    await assert.rejects(rail.prepare(req), /Refusing to sign|not paying|no deposit address/);
    assert.ok(!paths().includes('/v0/submit-intent'));
  });
}

// ---- broadcast + status --------------------------------------------------------------------------

test('broadcast submits the stored signed intent; a different accepted hash is an error', async () => {
  const ok = setup();
  const p = await ok.rail.prepare(req);
  ok.calls.length = 0;
  await ok.rail.broadcast(p.payload);
  assert.deepEqual(ok.calls[0]!.body, { type: 'swap_transfer', signedData: (JSON.parse(p.payload) as ConfidentialPayload).signed });

  const bad = setup({ submit: () => ({ status: 201, body: { intentHash: 'SomethingElse' } }) });
  await assert.rejects(bad.rail.broadcast(p.payload), /expected/);
});

test('submit: 5xx is retried, 4xx is an answer', async () => {
  let n = 0;
  const flaky = setup({ submit: () => (++n < 3 ? { status: 503, body: {} } : { status: 201, body: {} }) });
  const p = await flaky.rail.prepare(req);
  await flaky.rail.broadcast(p.payload);
  assert.equal(n, 3);
  const rejected = setup({ submit: () => ({ status: 400, body: { message: 'invalid signature' } }) });
  await assert.rejects(rejected.rail.broadcast(p.payload), /HTTP 400 invalid signature/);
});

async function statusOf(body: any, now = NOW) {
  const { rail } = setup({ status: () => ({ body }) }, now);
  const payload: ConfidentialPayload = { depositAddress: DEP, deadline: DEADLINE, signed: {} as never };
  return rail.status('ref', JSON.stringify(payload));
}

test('status: SUCCESS paid; REFUNDED / FAILED failed; in-progress states pending', async () => {
  assert.deepEqual(await statusOf({ status: 'SUCCESS' }), { state: 'success' });
  assert.equal((await statusOf({ status: 'REFUNDED', swapDetails: { refundReason: 'expired' } })).state, 'failed');
  assert.equal((await statusOf({ status: 'FAILED' })).state, 'failed');
  for (const s of ['PROCESSING', 'KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'SOMETHING_NEW']) assert.deepEqual(await statusOf({ status: s }), { state: 'pending' });
});

test('status: never executed = pending until an hour past the intent deadline, then dropped', async () => {
  const d = Date.parse(DEADLINE);
  assert.deepEqual(await statusOf({ status: 'PENDING_DEPOSIT' }), { state: 'pending' });
  assert.deepEqual(await statusOf({ status: 'PENDING_DEPOSIT' }, d + 30 * 60_000), { state: 'pending' });
  assert.deepEqual(await statusOf({ status: 'PENDING_DEPOSIT' }, d + 61 * 60_000), { state: 'dropped' });
  // executed (or executing) states are never turned into "dropped", however late
  assert.deepEqual(await statusOf({ status: 'PROCESSING' }, d + 7 * 86_400_000), { state: 'pending' });
});

test('status: an unreachable 1Click throws (attempt stays open), it does not guess', async () => {
  await assert.rejects(
    (async () => { const { rail } = setup({ status: () => ({ status: 502, body: {} }) }); return rail.status('ref', JSON.stringify({ depositAddress: DEP, deadline: DEADLINE })); })(),
    /unreachable/,
  );
});

// ---- balance (User-Session) and receivers --------------------------------------------------------

test('balance: signs an EMPTY intent for a User-Session, reads the private balance, reuses the session', async () => {
  const { rail, calls } = setup({ balances: [{ tokenId: `nep141:${USDC}`, available: '1500000', source: 'private' }, { tokenId: 'nep141:wrap.near', available: '9', source: 'private' }] });
  assert.equal(await rail.balance(token), 1_500_000n);
  assert.equal(await rail.balance(token), 1_500_000n);
  const auth = calls.filter((c) => c.path === '/v0/auth/authenticate');
  assert.equal(auth.length, 1);
  const sd = auth[0]!.body.signedData;
  assert.deepEqual(JSON.parse(sd.payload.message).intents, []);
  assert.equal(JSON.parse(sd.payload.message).signer_id, PAYER);
  assert.equal(Buffer.from(sd.payload.nonce, 'base64').subarray(5, 9).toString('hex'), 'e110f317');
  assert.ok(kp.getPublicKey().verify(nep413Hash(sd.payload), baseDecode(sd.signature.slice(8))));
  assert.equal(calls.find((c) => c.path === '/v0/account/balances')!.headers.authorization, 'Bearer user-session');
});

test('balance: no entry for the token = 0', async () => {
  const { rail } = setup({ balances: [] });
  assert.equal(await rail.balance(token), 0n);
});

test('receivers: missing named account refused, implicit accepted, payer itself refused', async () => {
  const { rail } = setup({ accounts: { 'nobody.near': false } });
  assert.match((await rail.ensureReceiver({ ...req, receiver: 'nobody.near' }))!, /does not exist/);
  assert.equal(await rail.ensureReceiver({ ...req, receiver: 'mill.near' }), null);
  assert.equal(await rail.ensureReceiver({ ...req, receiver: 'cc'.repeat(32) }), null);
  assert.match((await rail.ensureReceiver({ ...req, receiver: PAYER }))!, /payer account itself/);
  assert.equal(rail.link('x'), null);
});
