// Public rail: a plain NEP-141 ft_transfer from the payer account. Sender, receiver, amount and memo
// are visible on chain (and in explorers). Testnet first; the same code works on mainnet.
//
// The SDK (near-api-js) only builds and signs; reads, broadcast and status go through plain JSON-RPC
// so every error case is handled explicitly.

import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, SignedTransaction, actions, baseEncode, encodeTransaction, type KeyPairString } from 'near-api-js';
import type { NearNetwork, TokenConfig } from '../policy.ts';
import { IMPLICIT, NearRpc, RpcError } from './near-rpc.ts';
import type { PayRequest, Prepared, Rail, TxStatus } from './rail.ts';

const FT_TRANSFER_GAS = 30_000_000_000_000n; // 30 Tgas
const STORAGE_GAS = 30_000_000_000_000n;

export type PublicNearRailOptions = {
  network: NearNetwork;
  rpcUrl: string;
  payerAccountId: string;
  payerKey: KeyPairString;
  fetchFn?: typeof fetch;
};

export class PublicNearRail implements Rail {
  readonly name: string;
  readonly network: NearNetwork;
  private readonly near: NearRpc;
  private readonly payer: string;
  private readonly account: Account;
  private validityPeriod: number | null = null;

  constructor(o: PublicNearRailOptions) {
    this.network = o.network;
    this.name = `near-public-${o.network}`;
    this.near = new NearRpc(o.rpcUrl, o.fetchFn);
    this.payer = o.payerAccountId;
    this.account = new Account(o.payerAccountId, new JsonRpcProvider({ url: o.rpcUrl }), o.payerKey);
  }

  async balance(token: TokenConfig): Promise<bigint> {
    const v = await this.view<string>(token.contract, 'ft_balance_of', { account_id: this.payer });
    return BigInt(v);
  }

  async ensureReceiver(req: PayRequest): Promise<string | null> {
    // NEP-145 lets anyone register storage for an account id that does not exist; tokens sent there
    // are stuck. Implicit accounts exist as soon as they hold something, so they are fine.
    if (!IMPLICIT.test(req.receiver) && !(await this.accountExists(req.receiver))) {
      return `Payout account ${req.receiver} does not exist on NEAR ${this.network}; tokens sent there would be lost. Ask an approver to correct it.`;
    }
    const registered = await this.view<unknown>(req.token.contract, 'storage_balance_of', { account_id: req.receiver });
    if (registered !== null) return null;
    const bounds = await this.view<{ min: string }>(req.token.contract, 'storage_balance_bounds', {});
    // registration_only: refunds anything above the minimum; the payer pays so the supplier needs no gas
    await this.account.signAndSendTransaction({
      receiverId: req.token.contract,
      actions: [actions.functionCall('storage_deposit', { account_id: req.receiver, registration_only: true }, STORAGE_GAS, BigInt(bounds.min))],
      waitUntil: 'FINAL',
      throwOnFailure: true,
    });
    return null;
  }

  async prepare(req: PayRequest): Promise<Prepared> {
    const signed = await this.account.createSignedTransaction({
      receiverId: req.token.contract,
      actions: [
        actions.functionCall(
          'ft_transfer',
          { receiver_id: req.receiver, amount: req.units.toString(), memo: `PO ${req.poCode}` },
          FT_TRANSFER_GAS,
          1n, // NEP-141 requires exactly 1 yoctoNEAR
        ),
      ],
    });
    const ref = baseEncode(createHash('sha256').update(encodeTransaction(signed.transaction)).digest());
    return { ref, payload: Buffer.from(signed.encode()).toString('base64') };
  }

  async broadcast(payload: string): Promise<void> {
    // async: returns once the RPC accepted it; finality is checked by status()
    await this.rpc('send_tx', { signed_tx_base64: payload, wait_until: 'NONE' });
  }

  async status(ref: string, payload: string | null): Promise<TxStatus> {
    try {
      const r = await this.rpc<{ final_execution_status: string; status?: Record<string, unknown> }>('tx', {
        tx_hash: ref, sender_account_id: this.payer, wait_until: 'NONE',
      });
      if (r.final_execution_status !== 'FINAL' || !r.status) return { state: 'pending' };
      if ('SuccessValue' in r.status) return { state: 'success' };
      if ('Failure' in r.status) return { state: 'failed', error: JSON.stringify(r.status.Failure).slice(0, 500) };
      return { state: 'pending' };
    } catch (e) {
      if (!(e instanceof RpcError) || e.cause_name !== 'UNKNOWN_TRANSACTION') throw e;
      if (!payload) return { state: 'pending' };
      return (await this.expired(payload)) ? { state: 'dropped' } : { state: 'pending' };
    }
  }

  link(ref: string): string {
    return this.network === 'testnet' ? `https://testnet.nearblocks.io/txns/${ref}` : `https://nearblocks.io/txns/${ref}`;
  }

  /** True only when the chain PROVES the tx can no longer be included: the latest final block is past the
   *  tx's reference block height + the validity period. Any error or doubt returns false (still pending).
   *  Concluding "dropped" from an error would record a landed payment as failed, and a retry would pay twice.
   *  Seen 2026-11-03: decode() returns blockHash as a plain array, baseEncode threw, and the old code read the
   *  error as "expired" — two landed test payments were recorded as failed. Never infer expiry from an error. */
  private async expired(payload: string): Promise<boolean> {
    try {
      const tx = SignedTransaction.decode(Buffer.from(payload, 'base64')).transaction;
      this.validityPeriod ??= (await this.rpc<{ transaction_validity_period: number }>('EXPERIMENTAL_genesis_config', [])).transaction_validity_period;
      const refHeight = (await this.rpc<{ header: { height: number } }>('block', { block_id: baseEncode(Uint8Array.from(tx.blockHash)) })).header.height;
      const head = (await this.rpc<{ header: { height: number } }>('block', { finality: 'final' })).header.height;
      // margin of 100 blocks so a tx included at the edge is not misread
      return head > refHeight + this.validityPeriod + 100;
    } catch {
      // includes UNKNOWN_BLOCK: not yet propagated, or garbage-collected long ago. Either way, not proof.
      // A tx stuck here stays 'pending' and needs a human (see README "Stuck payments"); it is never re-paid.
      return false;
    }
  }

  private accountExists(id: string) { return this.near.accountExists(id); }
  private view<T>(c: string, m: string, a: object) { return this.near.view<T>(c, m, a); }
  private rpc<T = unknown>(m: string, p: unknown) { return this.near.call<T>(m, p); }
}
