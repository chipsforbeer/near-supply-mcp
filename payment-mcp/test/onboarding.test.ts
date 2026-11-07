// First-run setup from the chat: wallet creation, funding quotes, sign-in flow, setup check, and the
// extension's empty settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Funding } from '../src/fund.ts';
import { Ledger } from '../src/ledger.ts';
import type { OneClick } from '../src/rails/intents.ts';
import type { Rail } from '../src/rails/rail.ts';
import { Runtime, SetupNeeded } from '../src/runtime.ts';
import { SignInFlow } from '../src/signin.ts';
import { NotSignedIn, type SupplyAuth } from '../src/supply/auth.ts';
import type { SupplyApi } from '../src/supply/client.ts';
import { createWallet, implicitId, loadWallet } from '../src/wallet.ts';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'pay-onboard-'));
const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const PAYER = 'a'.repeat(64);
const NOW = Date.parse('2026-11-04T12:00:00Z');

// ---- wallet ----

test('wallet_create: an implicit account, key file 0600, read back, never replaced', async () => {
  const f = path.join(tmp(), 'w', 'wallet-mainnet.json');
  assert.equal(await loadWallet(f), null);
  const w = await createWallet(f);
  assert.match(w.accountId, /^[0-9a-f]{64}$/);
  assert.equal(w.accountId, implicitId(w.key));
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(await loadWallet(f), w);
  await assert.rejects(createWallet(f), /never replaced/);
  assert.deepEqual(await loadWallet(f), w, 'the original key is untouched');
});

test('a wallet file whose key does not match its account is refused', async () => {
  const f = path.join(tmp(), 'wallet.json');
  const w = await createWallet(f);
  writeFileSync(f, JSON.stringify({ account_id: 'b'.repeat(64), private_key: w.key }));
  await assert.rejects(loadWallet(f), /does not match/);
});

// ---- config from the extension (every field passed, empty when not filled in) ----

test('empty extension settings count as not set', () => {
  const c = loadConfig({ NEAR_NETWORK: 'mainnet', SUPPLY_URL: '', MAINNET_PAYER_ACCOUNT: '', MAINNET_PAYER_PRIVATE_KEY: ' ', ONECLICK_API_KEY: '', PER_PAYMENT_CAP: '', DAILY_CAP: '', SUPPLY_API_KEY: '' });
  assert.equal(c.supplyUrl.origin, 'http://127.0.0.1:8790');
  assert.equal(c.payer, null);
  assert.equal(c.oneClickApiKey, undefined);
  assert.equal(c.supplyApiKey, undefined);
  assert.equal(c.policy.perPaymentCap, '50');
  assert.equal(c.policy.dailyCap, '100');
  assert.match(c.walletFile, /wallet-mainnet\.json$/);
});

// ---- funding quotes ----

function goodQuote(over: { quote?: object; quoteRequest?: object } = {}) {
  return {
    quote: { depositAddress: '0xDEPOSIT000000000000000000000000000000001', amountIn: '5000000', amountOut: '4998990', minAmountOut: '4993991', deadline: '2026-11-04T13:00:00Z', timeEstimate: 35, ...over.quote },
    quoteRequest: { recipient: PAYER, recipientType: 'CONFIDENTIAL_INTENTS', refundTo: PAYER, refundType: 'CONFIDENTIAL_INTENTS', originAsset: BASE_USDC, destinationAsset: `nep141:${NEAR_USDC}`, ...over.quoteRequest },
  };
}
const tokens = [{ assetId: BASE_USDC, blockchain: 'base', symbol: 'USDC', decimals: 6 }, { assetId: `nep141:${NEAR_USDC}`, blockchain: 'near', symbol: 'USDC', decimals: 6 }];

function fakeApi(quote: object) {
  const sent: { method: string; path: string; body?: any }[] = [];
  const api = {
    async request(method: string, p: string, body?: object) {
      sent.push({ method, path: p, body });
      if (p === '/v0/tokens') return tokens;
      if (p === '/v0/quote') return quote;
      if (p.startsWith('/v0/status')) return { status: 'SUCCESS', swapDetails: { amountInFormatted: '5.0', amountOutFormatted: '4.99899', originChainTxHashes: [{ hash: '0xabc' }] } };
      throw new Error(`unexpected ${p}`);
    },
  } as unknown as OneClick;
  return { api, sent };
}
const funding = (api: OneClick) => new Funding({ api, payerAccountId: PAYER, nearUsdcContract: NEAR_USDC, now: () => NOW });

test('wallet_fund: asks for a deposit that credits and refunds only the payer, privately', async () => {
  const { api, sent } = fakeApi(goodQuote());
  const r = await funding(api).request('5', 'base');
  assert.deepEqual(r, {
    chain: 'base', chain_name: 'Base', send: '5', deposit_address: '0xDEPOSIT000000000000000000000000000000001', expires_at: '2026-11-04T13:00:00Z',
    expected_private_usdc: '4.99899', minimum_private_usdc: '4.993991', eta_seconds: 35, credited_to: PAYER,
  });
  const q = sent.find((s) => s.path === '/v0/quote')!.body;
  assert.equal(q.dry, false);
  assert.equal(q.depositType, 'ORIGIN_CHAIN');
  assert.equal(q.originAsset, BASE_USDC);
  assert.equal(q.amount, '5000000');
  assert.deepEqual([q.recipient, q.recipientType, q.refundTo, q.refundType], [PAYER, 'CONFIDENTIAL_INTENTS', PAYER, 'CONFIDENTIAL_INTENTS']);
});

const tampered: [string, object, RegExp][] = [
  ['no deposit address', { quote: { depositAddress: undefined } }, /no deposit address/],
  ['needs a memo', { quote: { depositMemo: '123' } }, /memo/],
  ['credits someone else', { quoteRequest: { recipient: 'attacker.near' } }, /someone else/],
  ['credits a public balance', { quoteRequest: { recipientType: 'INTENTS' } }, /someone else/],
  ['refunds someone else', { quoteRequest: { refundTo: '0xattacker' } }, /refunds/],
  ['refunds to the origin chain', { quoteRequest: { refundType: 'ORIGIN_CHAIN' } }, /refunds/],
  ['different origin token', { quoteRequest: { originAsset: 'nep141:base-0xother.omft.near' } }, /different tokens/],
  ['different destination token', { quoteRequest: { destinationAsset: 'nep141:usdt.tether-token.near' } }, /different tokens/],
  ['different amount in', { quote: { amountIn: '50000000' } }, /amount in/],
  ['delivers too little', { quote: { minAmountOut: '4900000' } }, /as little as/],
  ['delivers more than sent', { quote: { amountOut: '5000001' } }, /more than/],
  ['expires too soon', { quote: { deadline: '2026-11-04T12:05:00Z' } }, /too soon/],
];
for (const [name, over, re] of tampered) {
  test(`wallet_fund refuses a quote that ${name}`, async () => {
    await assert.rejects(funding(fakeApi(goodQuote(over)).api).request('5', 'base'), re);
  });
}

test('wallet_fund rejects zero and too many decimals before asking 1Click for a quote', async () => {
  const { api, sent } = fakeApi(goodQuote());
  await assert.rejects(funding(api).request('0', 'base'), /greater than zero/);
  await assert.rejects(funding(api).request('1.0000001', 'base'));
  assert.equal(sent.filter((s) => s.path === '/v0/quote').length, 0);
});

test('wallet_fund_status reports the credited amount', async () => {
  const s = await funding(fakeApi(goodQuote()).api).status('0xDEPOSIT');
  assert.equal(s.status, 'SUCCESS');
  assert.equal(s.credited_private_usdc, '4.99899');
  assert.deepEqual(s.source_tx, ['0xabc']);
});

// ---- sign-in from the chat ----

function fakeAuth(behaviour: 'ok' | 'fail-early' | 'fail-late') {
  let finish!: () => void;
  let fail!: (e: Error) => void;
  const auth = {
    login: (open: (u: URL) => Promise<void>) => new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
      if (behaviour === 'fail-early') return reject(new Error('cannot reach the supplier server'));
      void open(new URL('https://supply.example.test/authorize?client_id=x'));
    }),
  } as unknown as SupplyAuth;
  return { auth, finish: () => finish(), fail: (m: string) => fail(new Error(m)) };
}

test('payment_sign_in opens the page and returns; the session completes in the background', async () => {
  const opened: string[] = [];
  const a = fakeAuth('ok');
  const flow = new SignInFlow({ auth: a.auth, open: async (u) => (opened.push(u), true) });
  const r = await flow.start();
  assert.equal(r.state, 'waiting');
  assert.equal(r.browser_opened, true);
  assert.deepEqual(opened, ['https://supply.example.test/authorize?client_id=x']);
  assert.equal((await flow.start()).state, 'waiting', 'a second call does not start another sign-in');
  a.finish();
  await new Promise((r) => setImmediate(r));
  assert.equal(flow.current.state, 'signed_in');
});

test('payment_sign_in: failures before and after the page opens are reported, not hung on', async () => {
  const early = new SignInFlow({ auth: fakeAuth('fail-early').auth, open: async () => true });
  const r = await early.start();
  assert.equal(r.state, 'failed');
  assert.match((r as { error: string }).error, /cannot reach/);

  const late = fakeAuth('fail-late');
  const flow = new SignInFlow({ auth: late.auth, open: async () => false });
  assert.equal((await flow.start()).browser_opened, false);
  late.fail('Refusing a session with scopes [read write approve]');
  await new Promise((r) => setImmediate(r));
  assert.equal(flow.current.state, 'failed');
});

// ---- setup check ----

function fakeSupply(me: { scopes: string[] } | 'signed-out'): SupplyApi {
  return {
    async call<T>(op: string): Promise<T> {
      if (op !== 'whoami') throw new Error(`setup check must only call whoami, not ${op}`);
      if (me === 'signed-out') throw new NotSignedIn('no saved session');
      return { email: 'payments@brewery.example.test', company_name: 'Example Brewery', ...me } as T;
    },
  };
}

function runtime(env: Record<string, string>, supply: SupplyApi, balance = 0n) {
  const dir = tmp();
  const cfg = loadConfig({ NEAR_NETWORK: 'mainnet', WALLET_FILE: path.join(dir, 'wallet.json'), ...env });
  const signIn = new SignInFlow({ auth: fakeAuth('ok').auth, open: async () => true });
  return new Runtime({ cfg, supply, auth: {} as SupplyAuth, signIn, ledger: new Ledger(':memory:'),
    makeRail: () => ({ balance: async () => balance }) as unknown as Rail }).init();
}

test('setup check on a fresh install: everything missing, in order, and nothing can pay', async () => {
  const rt = await runtime({}, fakeSupply('signed-out'));
  const r = await rt.setupCheck();
  assert.equal(r.ready, false);
  assert.match(r.next, /partners\.near-intents\.org/);
  const bad = r.steps.filter((s) => !s.ok).map((s) => s.step);
  assert.deepEqual(bad, ['NEAR Intents API key', 'payer wallet', 'supplier server sign-in']);
  assert.throws(() => rt.get(), SetupNeeded);
});

test('setup check: after wallet_create and sign-in only the balance is left; a session with approve is flagged', async () => {
  const rt = await runtime({ ONECLICK_API_KEY: 'k' }, fakeSupply({ scopes: ['read', 'write'] }));
  const w = await rt.createWallet();
  assert.equal(rt.payer!.account_id, w.account_id);
  await assert.rejects(rt.createWallet(), /never replaced/);
  assert.equal(JSON.parse(readFileSync(w.stored_in, 'utf8')).account_id, w.account_id);
  const r = await rt.setupCheck();
  const byStep = Object.fromEntries(r.steps.map((s) => [s.step, s.ok]));
  assert.equal(byStep['payer wallet'], true);
  assert.equal(byStep['supplier server sign-in'], true);
  assert.equal(byStep['private balance'], false);
  assert.match(r.next, /wallet_fund/);
  const funded = await runtime({ ONECLICK_API_KEY: 'k' }, fakeSupply({ scopes: ['read', 'write'] }), 500_000n);
  await funded.createWallet();
  const ok = await funded.setupCheck();
  assert.equal(ok.ready, true, JSON.stringify(ok.steps));
  assert.equal(ok.steps.find((x) => x.step === 'private balance')!.detail, '0.5 USDC');

  const risky = await runtime({ ONECLICK_API_KEY: 'k' }, fakeSupply({ scopes: ['read', 'write', 'approve'] }));
  const s = (await risky.setupCheck()).steps.find((x) => x.step === 'supplier server sign-in')!;
  assert.equal(s.ok, false);
  assert.match(s.next!, /must not hold approve/);
});

test('a wallet from the settings wins over the wallet file, and wallet_create then refuses', async () => {
  const rt = await runtime({ MAINNET_PAYER_ACCOUNT: 'payer.near', MAINNET_PAYER_PRIVATE_KEY: 'ed25519:abc' }, fakeSupply('signed-out'));
  assert.deepEqual(rt.payer, { account_id: 'payer.near', source: 'settings' });
  await assert.rejects(rt.createWallet(), /already exists/);
});
