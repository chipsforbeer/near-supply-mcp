// Calls the supplier server's operations over HTTPS: POST /api/v1/ops/{name} { reason, args }.
// Writes carry a request_key; the server replays the cached result when the same key and args are
// sent again, which is what makes a retried payment hand-off safe.

import { SupplyAuth } from './auth.ts';

export class SupplyError extends Error {
  readonly op: string;
  readonly status: number;
  readonly code: string;
  constructor(op: string, status: number, code: string, message: string) {
    super(`${op}: ${code}: ${message}`);
    this.op = op;
    this.status = status;
    this.code = code;
  }
}

export type CallOptions = { reason: string; requestKey?: string };

export interface SupplyApi {
  call<T = unknown>(op: string, args: Record<string, unknown>, opts: CallOptions): Promise<T>;
}

export class SupplyClient implements SupplyApi {
  private readonly baseUrl: URL;
  private readonly auth: SupplyAuth;
  private readonly fetchFn: typeof fetch;
  constructor(baseUrl: URL, auth: SupplyAuth, fetchFn: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.auth = auth;
    this.fetchFn = fetchFn;
  }

  async call<T>(op: string, args: Record<string, unknown>, opts: CallOptions): Promise<T> {
    const body = JSON.stringify({
      reason: opts.reason,
      args: opts.requestKey ? { ...args, request_key: opts.requestKey, reason: opts.reason } : args,
    });
    const url = new URL(`/api/v1/ops/${encodeURIComponent(op)}`, this.baseUrl);
    let res = await this.post(url, body, await this.auth.accessToken());
    if (res.status === 401) res = await this.post(url, body, await this.auth.accessToken(true));
    const json = (await res.json().catch(() => null)) as
      | { ok: true; result: T }
      | { ok: false; error: { code: string; message?: string } }
      | null;
    if (!json) throw new SupplyError(op, res.status, 'bad_response', `HTTP ${res.status} with no JSON body`);
    if (!json.ok) throw new SupplyError(op, res.status, json.error.code, json.error.message ?? '');
    return json.result;
  }

  private post(url: URL, body: string, token: string) {
    return this.fetchFn(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  }
}
