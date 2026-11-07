// `npm run shield -- <amount>`: move working capital from the payer's NEAR wallet into its Confidential
// Intents balance, which the confidential rail pays from. A human runs this; it is not an MCP tool, so
// an AI can never move funds between balances.
//
// This step IS public: anyone can see that the payer moved <amount> into confidential balances. It says
// nothing about individual payments. Steps, each skipped when already done:
//   1. ft_transfer_call USDC → intents.near (credits our public Intents balance)
//   2. add_public_key on intents.near (so intents signed with our key are accepted)
//   3. 1Click quote INTENTS → CONFIDENTIAL_INTENTS, check + sign the transfer intent, submit, wait.

import { Account, JsonRpcProvider, KeyPair, actions } from 'near-api-js';
import { fromUnits, toUnits } from './amount.ts';
import type { Config } from './config.ts';
import { checkExactQuote, checkTransferIntent, signNep413, type Nep413Payload, type OneClick, type QuoteResponse } from './rails/intents.ts';
import type { NearRpc } from './rails/near-rpc.ts';
import type { ConfidentialRail } from './rails/confidential.ts';

const GAS = 50_000_000_000_000n;

export async function shield(o: { cfg: Config; amount: string; api: OneClick; rpc: NearRpc; rail: ConfidentialRail; log: (s: string) => void }) {
  const { cfg, api, rpc, rail, log } = o;
  const payer = cfg.payer!;
  const token = cfg.policy.tokens.usdc!;
  const units = toUnits(o.amount, token.decimals);
  if (units <= 0n) throw new Error('Amount must be greater than zero.');
  const tokenId = `nep141:${token.contract}`;
  const account = new Account(payer.accountId, new JsonRpcProvider({ url: cfg.rpcUrl }), payer.key);
  const send = async (receiverId: string, method: string, args: object) => {
    const r = await account.signAndSendTransaction({
      receiverId, actions: [actions.functionCall(method, args, GAS, 1n)], waitUntil: 'FINAL', throwOnFailure: true,
    });
    log(`  ${method}: https://nearblocks.io/txns/${r.transaction.hash}`);
  };

  const inIntents = BigInt(await rpc.view<string>('intents.near', 'mt_balance_of', { account_id: payer.accountId, token_id: tokenId }));
  if (inIntents < units) {
    const need = units - inIntents;
    const wallet = BigInt(await rpc.view<string>(token.contract, 'ft_balance_of', { account_id: payer.accountId }));
    if (wallet < need) throw new Error(`Wallet holds ${fromUnits(wallet, token.decimals)} USDC; ${fromUnits(need, token.decimals)} is needed.`);
    log(`1. Depositing ${fromUnits(need, token.decimals)} USDC into NEAR Intents`);
    await send(token.contract, 'ft_transfer_call', { receiver_id: 'intents.near', amount: need.toString(), msg: '' }); // '' = credit the sender
  } else log('1. Already in NEAR Intents: no deposit needed');

  const pk = KeyPair.fromString(payer.key).getPublicKey().toString();
  if (!(await rpc.view<boolean>('intents.near', 'has_public_key', { account_id: payer.accountId, public_key: pk }))) {
    log('2. Registering the payer key on intents.near');
    await send('intents.near', 'add_public_key', { public_key: pk });
  } else log('2. Payer key already registered on intents.near');

  log(`3. Shielding ${o.amount} USDC into the confidential balance`);
  const q = await api.request<QuoteResponse>('POST', '/v0/quote', {
    dry: false, swapType: 'EXACT_INPUT', originAsset: tokenId, destinationAsset: tokenId, amount: units.toString(), slippageTolerance: 0,
    depositType: 'INTENTS', recipient: payer.accountId, recipientType: 'CONFIDENTIAL_INTENTS', refundTo: payer.accountId, refundType: 'INTENTS',
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  const dep = checkExactQuote(q, units.toString(), payer.accountId, 'CONFIDENTIAL_INTENTS');
  const g = await api.request<{ intent?: { standard?: string; payload?: Nep413Payload } }>('POST', '/v0/generate-intent', {
    type: 'swap_transfer', standard: 'nep413', signerId: payer.accountId, depositAddress: dep,
  });
  if (g.intent?.standard !== 'nep413' || !g.intent.payload) throw new Error('1Click returned no NEP-413 intent.');
  checkTransferIntent(g.intent.payload, { contract: 'intents.near', signer: payer.accountId, depositAddress: dep, tokenId, units: units.toString(), now: Date.now() });
  await api.request('POST', '/v0/submit-intent', { type: 'swap_transfer', signedData: signNep413(payer.key, g.intent.payload) });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await api.request<{ status: string; swapDetails?: { refundReason?: string | null } }>('GET', `/v0/status?depositAddress=${dep}`);
    if (s.status === 'SUCCESS') {
      log(`  done. Confidential balance: ${fromUnits(await rail.balance(token), token.decimals)} USDC`);
      return;
    }
    if (s.status === 'REFUNDED' || s.status === 'FAILED') throw new Error(`Shield ${s.status}: ${s.swapDetails?.refundReason ?? ''}`);
  }
  throw new Error(`Shield still pending after 2 minutes; check: GET /v0/status?depositAddress=${dep}`);
}
