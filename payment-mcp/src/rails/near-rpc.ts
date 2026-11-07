// Plain NEAR JSON-RPC with explicit error handling, shared by both rails.

export class RpcError extends Error {
  readonly cause_name: string | undefined;
  constructor(message: string, causeName: string | undefined) {
    super(message);
    this.cause_name = causeName;
  }
}

export class NearRpc {
  private readonly url: string;
  private readonly fetchFn: typeof fetch;

  constructor(url: string, fetchFn: typeof fetch = fetch) {
    this.url = url;
    this.fetchFn = fetchFn;
  }

  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    // Transport problems (network, HTTP 429/5xx, non-JSON) are retried: every call here is a read or
    // send_tx of an already-signed tx, so repeating it is harmless. JSON-RPC errors are answers: not retried.
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 300 * 2 ** (attempt - 1)));
      let j: { result?: T & { error?: string }; error?: { cause?: { name?: string }; data?: unknown; message?: string } };
      try {
        const res = await this.fetchFn(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'pay', method, params }),
          signal: AbortSignal.timeout(20_000),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        j = (await res.json()) as typeof j;
      } catch (e) {
        last = e;
        continue;
      }
      if (j.error) throw new RpcError(`${method}: ${j.error.cause?.name ?? ''} ${JSON.stringify(j.error.data ?? j.error.message)}`, j.error.cause?.name);
      // view calls report contract errors inside result
      if (j.result && typeof j.result === 'object' && 'error' in j.result && j.result.error) throw new RpcError(`${method}: ${j.result.error}`, 'CONTRACT');
      return j.result as T;
    }
    throw new Error(`${method}: RPC unreachable after retries: ${(last as Error)?.message}`);
  }

  async view<T>(contract: string, method: string, args: object): Promise<T> {
    const r = await this.call<{ result: number[] }>('query', {
      request_type: 'call_function', finality: 'final', account_id: contract, method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    return JSON.parse(Buffer.from(r.result).toString('utf8')) as T;
  }

  async accountExists(accountId: string): Promise<boolean> {
    try {
      await this.call('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
      return true;
    } catch (e) {
      if (e instanceof RpcError && e.cause_name === 'UNKNOWN_ACCOUNT') return false;
      throw e;
    }
  }
}

export const IMPLICIT = /^([0-9a-f]{64}|0x[0-9a-f]{40})$/;
