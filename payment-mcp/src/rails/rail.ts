import type { NearNetwork, TokenConfig } from '../policy.ts';

export type PayRequest = {
  poId: string;
  poCode: string;
  receiver: string;
  token: TokenConfig;
  units: bigint;
};

/** A signed, not yet broadcast payment. Both fields are persisted before broadcasting, so a crash can
 *  re-send the identical transaction (same hash, same nonce: it can land at most once). */
export type Prepared = { ref: string; payload: string };

export type TxStatus =
  | { state: 'success' }
  | { state: 'failed'; error: string }
  | { state: 'pending' }
  /** the chain has never seen it and it can no longer be included (its block hash expired) */
  | { state: 'dropped' };

export interface Rail {
  readonly name: string;
  readonly network: NearNetwork;
  /** payer's balance of a token, in base units */
  balance(token: TokenConfig): Promise<bigint>;
  /** Make sure the receiver can receive the token (e.g. NEP-145 storage, paid by the payer).
   *  Returns a reason to refuse the payment (e.g. the account does not exist), or null. */
  ensureReceiver(req: PayRequest): Promise<string | null>;
  prepare(req: PayRequest): Promise<Prepared>;
  /** Send a prepared payload. Safe to call again with the same payload. */
  broadcast(payload: string): Promise<void>;
  status(ref: string, payload: string | null): Promise<TxStatus>;
  /** human link for the ref (explorer), or null when the rail is private */
  link(ref: string): string | null;
}
