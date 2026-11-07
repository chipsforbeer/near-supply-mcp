// Funding the payer's confidential balance from outside NEAR, with no NEAR wallet: 1Click gives a
// one-off deposit address on the chain the user picks (Base, Arbitrum, Solana…); USDC sent there
// arrives as confidential USDC on NEAR, credited to the payer. Refunds go to the payer's confidential
// balance too, so the user never has to give us an address.
//
// This only ever brings money IN to the payer's own balance: the recipient and the refund target are
// fixed to the payer here and checked against the quote. The user sends the money themselves, from an
// exchange or a wallet they control.
//
// Privacy: the deposit itself is public on the source chain (sender, amount, deposit address), like
// shielding. Individual supplier payments made later are not.

import { fromUnits, toUnits } from './amount.ts';
import type { OneClick } from './rails/intents.ts';

/** Chains whose USDC needs no memo or extra fields to deposit. Asset ids come from 1Click's live list. */
export const FUND_CHAINS = {
  base: 'Base',
  arb: 'Arbitrum',
  eth: 'Ethereum',
  op: 'Optimism',
  pol: 'Polygon',
  avax: 'Avalanche C-Chain',
  sol: 'Solana',
} as const;
export type FundChain = keyof typeof FUND_CHAINS;

const QUOTE_MINUTES = 60;
const SLIPPAGE_BPS = 50; // USDC → USDC; observed cost about 0.02% on 2026-11-04
const MAX_COST_BPS = 100; // refuse a quote that would deliver less than 99% of what is sent

type Token = { assetId: string; blockchain: string; symbol: string; decimals: number };
type Quote = {
  quote?: { depositAddress?: string; depositMemo?: string; amountIn: string; amountOut: string; minAmountOut: string; deadline?: string; timeEstimate?: number };
  quoteRequest?: { recipient?: string; recipientType?: string; refundTo?: string; refundType?: string; destinationAsset?: string; originAsset?: string };
};

export type FundingRequest = {
  chain: FundChain;
  chain_name: string;
  send: string; // exact USDC amount to send on the source chain
  deposit_address: string;
  expires_at: string;
  expected_private_usdc: string;
  minimum_private_usdc: string;
  eta_seconds: number | null;
  credited_to: string;
};

export class Funding {
  private readonly api: OneClick;
  private readonly payer: string;
  private readonly nearUsdc: string; // nep141:<contract>
  private readonly now: () => number;
  constructor(o: { api: OneClick; payerAccountId: string; nearUsdcContract: string; now?: () => number }) {
    this.api = o.api;
    this.payer = o.payerAccountId;
    this.nearUsdc = `nep141:${o.nearUsdcContract}`;
    this.now = o.now ?? Date.now;
  }

  private async usdcOn(chain: FundChain): Promise<Token> {
    const list = await this.api.request<Token[]>('GET', '/v0/tokens');
    const found = list.filter((t) => t.symbol === 'USDC' && t.blockchain === chain);
    if (found.length !== 1) throw new Error(`1Click lists ${found.length} USDC tokens on ${chain}; expected exactly one.`);
    return found[0]!;
  }

  async request(amount: string, chain: FundChain): Promise<FundingRequest> {
    if (!(chain in FUND_CHAINS)) throw new Error(`Unsupported chain ${chain}.`);
    const origin = await this.usdcOn(chain);
    const units = toUnits(amount, origin.decimals);
    if (units <= 0n) throw new Error('Amount must be greater than zero.');
    const deadline = new Date(this.now() + QUOTE_MINUTES * 60_000).toISOString();
    const q = await this.api.request<Quote>('POST', '/v0/quote', {
      dry: false, swapType: 'EXACT_INPUT', originAsset: origin.assetId, destinationAsset: this.nearUsdc,
      amount: units.toString(), slippageTolerance: SLIPPAGE_BPS, depositType: 'ORIGIN_CHAIN',
      recipient: this.payer, recipientType: 'CONFIDENTIAL_INTENTS',
      refundTo: this.payer, refundType: 'CONFIDENTIAL_INTENTS', deadline,
    });
    return this.check(q, { units, origin, chain });
  }

  /** Everything the user will act on is checked against what we asked for. */
  check(q: Quote, want: { units: bigint; origin: Token; chain: FundChain }): FundingRequest {
    const r = q.quoteRequest ?? {};
    const qt = q.quote;
    const bad = (why: string) => new Error(`1Click funding quote rejected: ${why}.`);
    if (!qt?.depositAddress) throw bad('no deposit address');
    if (qt.depositMemo) throw bad('it needs a memo, which this tool does not support');
    if (r.recipient !== this.payer || r.recipientType !== 'CONFIDENTIAL_INTENTS') throw bad('it would credit someone else');
    if (r.refundTo !== this.payer || r.refundType !== 'CONFIDENTIAL_INTENTS') throw bad('refunds would go somewhere else');
    if (r.originAsset !== want.origin.assetId || r.destinationAsset !== this.nearUsdc) throw bad('different tokens than requested');
    if (qt.amountIn !== want.units.toString()) throw bad(`amount in is ${qt.amountIn}, not ${want.units}`);
    // both sides are USDC; compare in NEAR USDC units (6 decimals)
    const sent6 = scale(want.units, want.origin.decimals, 6);
    const min = BigInt(qt.minAmountOut);
    if (min * 10_000n < sent6 * BigInt(10_000 - MAX_COST_BPS)) throw bad(`it would deliver as little as ${fromUnits(min, 6)} for ${fromUnits(sent6, 6)}`);
    if (BigInt(qt.amountOut) > sent6) throw bad('it would deliver more than is sent');
    const expires = qt.deadline ?? '';
    if (!(Date.parse(expires) > this.now() + 10 * 60_000)) throw bad('it expires too soon');
    return {
      chain: want.chain,
      chain_name: FUND_CHAINS[want.chain],
      send: fromUnits(want.units, want.origin.decimals),
      deposit_address: qt.depositAddress,
      expires_at: expires,
      expected_private_usdc: fromUnits(BigInt(qt.amountOut), 6),
      minimum_private_usdc: fromUnits(min, 6),
      eta_seconds: qt.timeEstimate ?? null,
      credited_to: this.payer,
    };
  }

  async status(depositAddress: string) {
    const s = await this.api.request<{ status: string; swapDetails?: { amountInFormatted?: string; amountOutFormatted?: string; refundedAmountFormatted?: string; refundReason?: string | null; originChainTxHashes?: { hash: string }[] } }>(
      'GET', `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
    );
    const d = s.swapDetails ?? {};
    return {
      status: s.status,
      meaning: STATUS_MEANING[s.status] ?? 'unknown status',
      received: d.amountInFormatted ?? null,
      credited_private_usdc: s.status === 'SUCCESS' ? d.amountOutFormatted ?? null : null,
      refunded: d.refundedAmountFormatted ?? null,
      refund_reason: d.refundReason ?? null,
      source_tx: d.originChainTxHashes?.map((t) => t.hash) ?? [],
    };
  }
}

const STATUS_MEANING: Record<string, string> = {
  PENDING_DEPOSIT: 'waiting for the deposit to arrive on the source chain',
  KNOWN_DEPOSIT_TX: 'deposit seen, waiting for confirmations',
  INCOMPLETE_DEPOSIT: 'less than the quoted amount arrived; send the rest or wait for the refund',
  PROCESSING: 'deposit received, crediting the private balance',
  SUCCESS: 'credited to the private balance',
  REFUNDED: 'refunded to the private balance as-is (see refund_reason)',
  FAILED: 'failed; contact NEAR Intents support with the deposit address',
};

function scale(v: bigint, from: number, to: number): bigint {
  return from >= to ? v / 10n ** BigInt(from - to) : v * 10n ** BigInt(to - from);
}
