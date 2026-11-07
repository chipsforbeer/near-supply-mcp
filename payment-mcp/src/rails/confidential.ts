// Confidential rail (mainnet): pays from our Confidential Intents balance to the supplier's, through
// 1Click. The amount and the payee do not appear on the public NEAR chain or in public explorers; only
// the two parties (and the operators of the private shard) see them.
//
// One payment = a 1Click quote (CONFIDENTIAL_INTENTS → CONFIDENTIAL_INTENTS, same token, exact amount),
// then the NEP-413 `transfer` intent 1Click generates for it, which we check field by field and sign.
// The intent hash is computed locally, so it is persisted before anything is submitted, like a tx hash
// on the public rail. Its nonce is single-use: re-submitting the same signed intent cannot pay twice.
//
// Funding is separate and deliberately not an MCP tool: a human shields working capital with
// `npm run shield` (see src/shield.ts).

import type { KeyPairString } from 'near-api-js';
import type { TokenConfig } from '../policy.ts';
import { IMPLICIT, NearRpc } from './near-rpc.ts';
import {
  OneClick, UserSession, checkExactQuote, checkTransferIntent, intentHash, signNep413,
  type Nep413Payload, type QuoteResponse, type SignedNep413,
} from './intents.ts';
import type { PayRequest, Prepared, Rail, TxStatus } from './rail.ts';

/** Shared protocol treasury backing confidential tokens (`imt:<treasury>:<token>`).
 *  This is a service protocol identifier, not a payer wallet or supplier payout account. */
export const PRIVATE_TREASURY = '51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe';
/** A never-executed intent counts as dropped only this long after its deadline. */
const DROP_MARGIN_MS = 60 * 60_000;

export type ConfidentialPayload = { depositAddress: string; deadline: string; signed: SignedNep413 };

export type ConfidentialRailOptions = {
  payerAccountId: string;
  payerKey: KeyPairString;
  api: OneClick;
  rpc: NearRpc;
  now?: () => number;
};

export class ConfidentialRail implements Rail {
  readonly name = 'near-confidential-mainnet';
  readonly network = 'mainnet' as const;
  private readonly payer: string;
  private readonly key: KeyPairString;
  private readonly api: OneClick;
  private readonly rpc: NearRpc;
  private readonly now: () => number;
  readonly session: UserSession;

  constructor(o: ConfidentialRailOptions) {
    this.payer = o.payerAccountId;
    this.key = o.payerKey;
    this.api = o.api;
    this.rpc = o.rpc;
    this.now = o.now ?? Date.now;
    this.session = new UserSession({
      api: o.api, accountId: o.payerAccountId, key: o.payerKey, now: this.now,
      salt: async () => Buffer.from(await this.rpc.view<string>('intents.near', 'current_salt', {}), 'hex'),
    });
  }

  /** Our confidential (private) balance of the token, in base units. */
  async balance(token: TokenConfig): Promise<bigint> {
    const b = (await this.session.balances()).find((x) => x.tokenId === `nep141:${token.contract}`);
    return BigInt(b?.available ?? '0');
  }

  async ensureReceiver(req: PayRequest): Promise<string | null> {
    if (req.receiver === this.payer) return 'The payout account is the payer account itself.';
    // A named account that does not exist can never sign to use or withdraw its confidential balance.
    if (!IMPLICIT.test(req.receiver) && !(await this.rpc.accountExists(req.receiver))) {
      return `Payout account ${req.receiver} does not exist on NEAR mainnet; it could never use the payment. Ask an approver to correct it.`;
    }
    return null;
  }

  async prepare(req: PayRequest): Promise<Prepared> {
    const units = req.units.toString();
    const asset = `nep141:${req.token.contract}`;
    const q = await this.api.request<QuoteResponse>('POST', '/v0/quote', {
      dry: false, swapType: 'EXACT_INPUT', originAsset: asset, destinationAsset: asset, amount: units, slippageTolerance: 0,
      depositType: 'CONFIDENTIAL_INTENTS', recipient: req.receiver, recipientType: 'CONFIDENTIAL_INTENTS',
      refundTo: this.payer, refundType: 'CONFIDENTIAL_INTENTS',
      deadline: new Date(this.now() + 30 * 60_000).toISOString(),
    });
    const dep = checkExactQuote(q, units, req.receiver, 'CONFIDENTIAL_INTENTS');
    const g = await this.api.request<{ intent?: { standard?: string; payload?: Nep413Payload } }>('POST', '/v0/generate-intent', {
      type: 'swap_transfer', standard: 'nep413', signerId: this.payer, depositAddress: dep,
    });
    if (g.intent?.standard !== 'nep413' || !g.intent.payload) throw new Error('1Click returned no NEP-413 intent.');
    const deadline = checkTransferIntent(g.intent.payload, {
      contract: 'intents.far', signer: this.payer, depositAddress: dep, units, now: this.now(),
      tokenId: `imt:${PRIVATE_TREASURY}:nep141:${req.token.contract}`,
    });
    const signed = signNep413(this.key, g.intent.payload);
    const payload: ConfidentialPayload = { depositAddress: dep, deadline, signed };
    return { ref: intentHash(signed.payload), payload: JSON.stringify(payload) };
  }

  async broadcast(payload: string): Promise<void> {
    const p = JSON.parse(payload) as ConfidentialPayload;
    const r = await this.api.request<{ intentHash?: string }>('POST', '/v0/submit-intent', { type: 'swap_transfer', signedData: p.signed });
    const ours = intentHash(p.signed.payload);
    if (r.intentHash && r.intentHash !== ours) throw new Error(`1Click accepted intent ${r.intentHash}, expected ${ours}`);
  }

  async status(_ref: string, payload: string | null): Promise<TxStatus> {
    if (!payload) return { state: 'pending' };
    const p = JSON.parse(payload) as ConfidentialPayload;
    const s = await this.api.request<{ status: string; swapDetails?: { refundReason?: string | null } }>(
      'GET', `/v0/status?depositAddress=${encodeURIComponent(p.depositAddress)}`,
    );
    switch (s.status) {
      case 'SUCCESS': return { state: 'success' };
      case 'REFUNDED': return { state: 'failed', error: `1Click refunded the payment to the payer: ${s.swapDetails?.refundReason ?? 'no reason given'}` };
      case 'FAILED': return { state: 'failed', error: '1Click reports the payment FAILED.' };
      case 'PENDING_DEPOSIT':
        // our signed transfer has not executed. Past its deadline it never can (the contract rejects it),
        // and the margin covers 1Click's own lag. Until then: pending, and pay.ts re-submits.
        return this.now() > Date.parse(p.deadline) + DROP_MARGIN_MS ? { state: 'dropped' } : { state: 'pending' };
      default: // KNOWN_DEPOSIT_TX, INCOMPLETE_DEPOSIT, PROCESSING, or anything new: not final
        return { state: 'pending' };
    }
  }

  /** private: there is no public explorer page that shows it */
  link(_ref: string): null {
    return null;
  }
}
