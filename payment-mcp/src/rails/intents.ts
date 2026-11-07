// NEAR Intents plumbing for the confidential rail: the 1Click API, NEP-413 signing, versioned nonces
// and the User-Session token that reveals our own private balance.
//
// Verified on mainnet 2026-11-04: Confidential Intents have no RPC path ("there is no RPC path for
// confidential intents"); every private transfer goes through 1Click with a partner API key.

import { createHash, getRandomValues } from 'node:crypto';
import { KeyPair, baseEncode, type KeyPairString } from 'near-api-js';

export const ONECLICK_URL = 'https://1click.chaindefuser.com';

export class OneClickError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class OneClick {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(o: { apiKey: string; baseUrl?: string; fetchFn?: typeof fetch }) {
    this.base = o.baseUrl ?? ONECLICK_URL;
    this.apiKey = o.apiKey;
    this.fetchFn = o.fetchFn ?? fetch;
  }

  /** Transport problems (network, 429, 5xx, non-JSON) are retried. Every call we make is safe to repeat:
   *  quote/generate create nothing that moves money, and re-submitting a signed intent cannot execute it
   *  twice (its nonce is single-use; checked on mainnet 2026-11-04). 4xx answers are returned as errors. */
  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      let res: Response;
      let text: string;
      try {
        res = await this.fetchFn(this.base + path, {
          method,
          headers: { 'content-type': 'application/json', 'X-API-Key': this.apiKey, ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        text = await res.text();
      } catch (e) {
        last = e;
        continue;
      }
      if (res.status === 429 || res.status >= 500) { last = new Error(`HTTP ${res.status}`); continue; }
      let j: unknown;
      try { j = JSON.parse(text); } catch { last = new Error(`non-JSON reply (HTTP ${res.status})`); continue; }
      if (res.status >= 400) {
        const msg = (j as { message?: unknown })?.message;
        throw new OneClickError(`1Click ${method} ${path.split('?')[0]}: HTTP ${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(j).slice(0, 300)}`, res.status, j);
      }
      return j as T;
    }
    throw new Error(`1Click ${method} ${path.split('?')[0]}: unreachable after retries: ${(last as Error)?.message}`);
  }
}

// ---- NEP-413 -------------------------------------------------------------------------------------

export type Nep413Payload = { message: string; nonce: string; recipient: string; callbackUrl?: string | null };
export type SignedNep413 = { standard: 'nep413'; payload: Nep413Payload; public_key: string; signature: string };

const borshString = (s: string) => {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
};

/** sha256( u32le(2^31 + 413) || borsh{ message, nonce[32], recipient, callbackUrl: Option<string> } ).
 *  For NEAR Intents this hash, base58-encoded, is also the intent hash. */
export function nep413Hash(p: Nep413Payload): Buffer {
  const nonce = Buffer.from(p.nonce, 'base64');
  if (nonce.length !== 32) throw new Error(`NEP-413 nonce must be 32 bytes, got ${nonce.length}`);
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  const cb = p.callbackUrl ? Buffer.concat([Buffer.from([1]), borshString(p.callbackUrl)]) : Buffer.from([0]);
  return createHash('sha256').update(Buffer.concat([tag, borshString(p.message), nonce, borshString(p.recipient), cb])).digest();
}

export const intentHash = (p: Nep413Payload) => baseEncode(nep413Hash(p));

export function signNep413(key: KeyPairString, payload: Nep413Payload): SignedNep413 {
  const kp = KeyPair.fromString(key);
  const { signature } = kp.sign(nep413Hash(payload));
  return { standard: 'nep413', payload, public_key: kp.getPublicKey().toString(), signature: 'ed25519:' + baseEncode(signature) };
}

// ---- versioned nonce (what /v0/auth/authenticate requires) ---------------------------------------

const NONCE_MAGIC = [0x56, 0x28, 0xf6, 0xc6];

/** base64( magic[4] || version 0 || salt[4] || deadline u64le ns || start u64le ns || random[7] ),
 *  the layout of @defuse-protocol/intents-sdk VersionedNonceBuilder with timestamped random bytes. */
export function versionedNonce(salt: Uint8Array, deadline: Date, start: Date, random: Uint8Array = getRandomValues(new Uint8Array(7))): string {
  if (salt.length !== 4) throw new Error('salt must be 4 bytes');
  if (random.length !== 7) throw new Error('random must be 7 bytes');
  const b = Buffer.alloc(32);
  b.set(NONCE_MAGIC, 0);
  b[4] = 0;
  b.set(salt, 5);
  b.writeBigUInt64LE(BigInt(deadline.getTime()) * 1_000_000n, 9);
  b.writeBigUInt64LE(BigInt(start.getTime()) * 1_000_000n, 17);
  b.set(random, 25);
  return b.toString('base64');
}

// ---- User-Session: reads our own confidential balance --------------------------------------------

export class UserSession {
  private readonly api: OneClick;
  private readonly accountId: string;
  private readonly key: KeyPairString;
  private readonly salt: () => Promise<Uint8Array>;
  private readonly now: () => number;
  private token: { value: string; until: number } | null = null;

  constructor(o: { api: OneClick; accountId: string; key: KeyPairString; salt: () => Promise<Uint8Array>; now?: () => number }) {
    this.api = o.api;
    this.accountId = o.accountId;
    this.key = o.key;
    this.salt = o.salt;
    this.now = o.now ?? Date.now;
  }

  /** Signs an EMPTY intent ("intents": [] moves nothing) to prove we own the account. */
  async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.until) return this.token.value;
    const start = new Date(this.now());
    const deadline = new Date(this.now() + 5 * 60_000);
    const payload: Nep413Payload = {
      recipient: 'intents.near',
      nonce: versionedNonce(await this.salt(), deadline, start),
      message: JSON.stringify({ deadline: deadline.toISOString(), intents: [], signer_id: this.accountId }),
    };
    const r = await this.api.request<{ accessToken: string; expiresIn: number }>('POST', '/v0/auth/authenticate', { signedData: signNep413(this.key, payload) });
    this.token = { value: r.accessToken, until: this.now() + Math.max(0, r.expiresIn - 60) * 1000 };
    return r.accessToken;
  }

  async balances(): Promise<{ tokenId: string; available: string; source: string }[]> {
    const r = await this.api.request<{ balances: { tokenId: string; available: string; source: string }[] }>(
      'GET', '/v0/account/balances', undefined, { authorization: `Bearer ${await this.accessToken()}` },
    );
    return r.balances;
  }
}

// ---- the only intent shape we ever sign ----------------------------------------------------------

/** Refuses anything but ONE `transfer` of exactly `units` of `tokenId`, signed by `signer`, to the 1Click
 *  deposit address, on `contract`, with a future deadline and no callback. Returns the deadline. */
export function checkTransferIntent(
  p: Nep413Payload,
  want: { contract: 'intents.near' | 'intents.far'; signer: string; depositAddress: string; tokenId: string; units: string; now: number },
): string {
  const bad = (why: string) => new Error(`Refusing to sign the 1Click intent: ${why}`);
  if (p.recipient !== want.contract) throw bad(`recipient contract is ${p.recipient}, not ${want.contract}`);
  if (p.callbackUrl) throw bad('it has a callback URL');
  let m: { signer_id?: unknown; deadline?: unknown; intents?: unknown };
  try { m = JSON.parse(p.message); } catch { throw bad('message is not JSON'); }
  if (Object.keys(m).sort().join() !== 'deadline,intents,signer_id') throw bad(`unexpected message fields ${Object.keys(m).join(',')}`);
  if (m.signer_id !== want.signer) throw bad(`signer is ${String(m.signer_id)}`);
  if (typeof m.deadline !== 'string' || !(Date.parse(m.deadline) > want.now)) throw bad('deadline is missing or past');
  if (!Array.isArray(m.intents) || m.intents.length !== 1) throw bad('it must contain exactly one intent');
  const i = m.intents[0] as Record<string, unknown>;
  if (Object.keys(i).sort().join() !== 'intent,receiver_id,tokens') throw bad(`unexpected intent fields ${Object.keys(i).join(',')}`);
  if (i.intent !== 'transfer') throw bad(`intent type is ${String(i.intent)}`);
  if (i.receiver_id !== want.depositAddress) throw bad('receiver is not the quote deposit address');
  if (JSON.stringify(i.tokens) !== JSON.stringify({ [want.tokenId]: want.units })) throw bad(`tokens are ${JSON.stringify(i.tokens)}`);
  return m.deadline;
}

export type QuoteResponse = {
  quote?: { depositAddress?: string; amountIn: string; amountOut: string; minAmountOut: string; deadline?: string };
  quoteRequest?: { recipient?: string; recipientType?: string };
};

/** Same token in and out, exact amount: the receiver must get exactly `units`, with no fee taken from it. */
export function checkExactQuote(q: QuoteResponse, units: string, recipient: string, recipientType: string): string {
  const quote = q.quote;
  if (!quote?.depositAddress) throw new Error('1Click quote has no deposit address.');
  if (quote.amountIn !== units || quote.minAmountOut !== units || quote.amountOut !== units) {
    throw new Error(`1Click quote would not deliver exactly ${units} (in ${quote.amountIn}, out ${quote.amountOut}, min ${quote.minAmountOut}); not paying.`);
  }
  if (q.quoteRequest && (q.quoteRequest.recipient !== recipient || q.quoteRequest.recipientType !== recipientType)) {
    throw new Error('1Click quote echoes a different recipient; not paying.');
  }
  return quote.depositAddress;
}
