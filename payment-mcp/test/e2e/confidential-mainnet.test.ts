// End to end on the CONFIDENTIAL rail: the local demo supplier server (fictional companies only) and
// real NEAR mainnet Confidential Intents. Spends REAL money (0.50 USDC per run), so it has its own
// opt-in: `E2E_MAINNET=1 npm run test:e2e:mainnet`. Needs:
//   - the demo server on http://127.0.0.1:8790 and its keys (see local-demo.test.ts)
//   - MAINNET_PAYER_ACCOUNT / MAINNET_PAYER_PRIVATE_KEY and ONECLICK_API_KEY in .env.local
//   - >= 0.50 USDC in the payer's confidential balance (`npm run shield -- 0.50`)
//   - a receiver key file (default ~/.config/near-payment-mcp/mainnet-keys/conf-recipient-1.json:
//     {account_id, private_key}); its key is used only to READ its confidential balance.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { Ledger } from '../../src/ledger.ts';
import { Payments } from '../../src/pay.ts';
import type { PolicyConfig, TokenConfig } from '../../src/policy.ts';
import { ConfidentialRail } from '../../src/rails/confidential.ts';
import { OneClick } from '../../src/rails/intents.ts';
import { NearRpc } from '../../src/rails/near-rpc.ts';
import type { SupplyClient } from '../../src/supply/client.ts';
import { BUYER, OWNER, clientFor, demoPos } from './demo.ts';

const enabled = process.env.E2E_MAINNET === '1';
const receiverFile = process.env.CONF_RECEIVER_FILE ?? path.join(os.homedir(), '.config', 'near-payment-mcp', 'mainnet-keys', 'conf-recipient-1.json');

let dir: string;
let buyer: SupplyClient;
let api: OneClick;
let rail: ConfidentialRail;
let receiverView: ConfidentialRail; // the receiver's own sign-in, to read its confidential balance
let receiver: string;
let payments: Payments;
let policy: PolicyConfig;
let usdc: TokenConfig;
let pos: ReturnType<typeof demoPos>;

before(async () => {
  if (!enabled) return;
  const cfg = loadConfig({ ...process.env, NEAR_NETWORK: 'mainnet' });
  if (!cfg.payer || !cfg.oneClickApiKey) throw new Error('MAINNET_PAYER_ACCOUNT / MAINNET_PAYER_PRIVATE_KEY / ONECLICK_API_KEY missing');
  const r = JSON.parse(readFileSync(receiverFile, 'utf8')) as { account_id: string; private_key: string };
  receiver = r.account_id;
  dir = mkdtempSync(path.join(os.tmpdir(), 'pay-e2e-main-'));
  const owner = await clientFor(dir, OWNER, 'read write approve');
  buyer = await clientFor(dir, BUYER, 'read write');
  pos = demoPos(owner, Date.now().toString(36));
  await pos.init();
  api = new OneClick({ apiKey: cfg.oneClickApiKey });
  const rpc = new NearRpc(cfg.rpcUrl);
  rail = new ConfidentialRail({ payerAccountId: cfg.payer.accountId, payerKey: cfg.payer.key, api, rpc });
  receiverView = new ConfidentialRail({ payerAccountId: receiver, payerKey: r.private_key as never, api, rpc });
  usdc = cfg.policy.tokens.usdc!;
  policy = { ...cfg.policy, perPaymentCap: '1', dailyCap: '5' };
  payments = new Payments({ supply: buyer, ledger: new Ledger(path.join(dir, 'ledger.db')), rail, policy, settleTimeoutMs: 90_000 });
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('pays an approved PO confidentially on mainnet; the PO records the intent hash', { skip: !enabled }, async () => {
  await pos.setPayout(receiver);
  const po = await pos.approvedPo('1', '0.50');
  const [payerBefore, receiverBefore] = [await rail.balance(usdc), await receiverView.balance(usdc)];
  assert.ok(payerBefore >= 500_000n, `payer confidential balance is ${payerBefore}; run npm run shield -- 0.50`);

  const preview = await payments.preview(po.po_id);
  assert.equal(preview.would_pay, true, preview.reasons.join(' '));
  assert.equal(preview.rail, 'near-confidential-mainnet');

  const r = await payments.pay(po.po_id);
  assert.equal(r.outcome, 'paid', JSON.stringify(r));
  assert.equal(r.link, null); // nothing to link to: it is not on a public explorer

  // both private balances moved by exactly 0.50
  assert.equal(payerBefore - (await rail.balance(usdc)), 500_000n);
  assert.equal((await receiverView.balance(usdc)) - receiverBefore, 500_000n);

  // 1Click: settled, and no public NEAR transaction was made for it
  const { attempts } = await payments.status(po.po_id);
  assert.equal(attempts.at(-1)!.tx_ref, r.tx_ref);
  const payload = JSON.parse(new Ledger(path.join(dir, 'ledger.db')).latest(po.po_id)!.tx_payload!);
  const st = await api.request<any>('GET', `/v0/status?depositAddress=${payload.depositAddress}`);
  assert.equal(st.status, 'SUCCESS');
  assert.equal(st.swapDetails.amountOut, '500000');
  assert.deepEqual(st.swapDetails.nearTxHashes, []);

  // the PO: paid, with our intent hash as the payment reference
  const live = await buyer.call<any>('po_get', { po_id: po.po_id }, { reason: 'e2e: check PO after payment' });
  assert.equal(live.payment_status, 'paid');
  assert.equal(live.payment_ref, r.tx_ref);

  const again = await payments.pay(po.po_id);
  assert.equal(again.outcome, 'not_instructed');
});

test('a PO above the cap is refused on the confidential rail and nothing moves', { skip: !enabled }, async () => {
  await pos.setPayout(receiver);
  const po = await pos.approvedPo('1', '1.50');
  const before = await rail.balance(usdc);
  const r = await payments.pay(po.po_id);
  assert.equal(r.outcome, 'refused');
  assert.match(r.reasons!.join(' '), /per-payment cap/);
  assert.equal(await rail.balance(usdc), before);
});
