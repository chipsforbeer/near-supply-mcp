import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// The route between this machine and the server can drop connections. A retry is made only when
// it cannot repeat a change:
// - any request, when the connection failed before the request left this machine;
// - reads (search, downloads) and uploads (the server returns the first result for the same
//   request key and file) on any dropped connection or gateway error.
// execute is never retried once its request may have reached the server: its code may write.

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 6000];

const NOT_SENT = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN']);
// Proxy and Cloudflare gateway answers: the origin was unreachable, slow or failed in between.
export const GATEWAY_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

export type Log = (line: string) => void;
export const stderrLog: Log = (line) => process.stderr.write(`${line}\n`);

export class GatewayError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`The server's gateway answered HTTP ${status}.`);
    this.status = status;
  }
}

function chain(e: unknown): unknown[] {
  const out: unknown[] = [];
  for (let x = e, i = 0; x && i < 6; x = (x as { cause?: unknown }).cause, i += 1) out.push(x);
  return out;
}

function isFetchFailure(e: unknown): boolean {
  return chain(e).some((x) => x instanceof TypeError && /fetch failed/i.test(x.message));
}

export function failedBeforeSending(e: unknown): boolean {
  return isFetchFailure(e) && chain(e).some((x) => NOT_SENT.has(String((x as { code?: unknown }).code)));
}

export function isTransient(e: unknown): boolean {
  if (isFetchFailure(e) || e instanceof GatewayError) return true;
  if (e instanceof McpError) return e.code === ErrorCode.RequestTimeout || e.code === ErrorCode.ConnectionClosed;
  if (e instanceof StreamableHTTPError) return e.code !== undefined && GATEWAY_STATUSES.has(e.code);
  return false;
}

function describe(e: unknown): string {
  const codes = chain(e).map((x) => (x as { code?: unknown }).code).filter((c) => c !== undefined);
  const message = e instanceof Error ? e.message : String(e);
  return codes.length ? `${message} (${codes.join(', ')})` : message;
}

export async function retrying<T>(
  what: string,
  fn: () => Promise<T>,
  retryIf: (e: unknown) => boolean,
  delaysMs: readonly number[],
  log: Log,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= delaysMs.length || !retryIf(e)) throw e;
      const wait = delaysMs[attempt] ?? 0;
      log(`network: ${what} failed: ${describe(e)}; retrying in ${wait} ms (attempt ${attempt + 2} of ${delaysMs.length + 1})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// For the MCP connection and sign-in: re-sends only requests that never left this machine.
export function retryingFetch(base: typeof fetch, delaysMs: readonly number[], log: Log): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    retrying('request', () => base(input, init), failedBeforeSending, delaysMs, log)) as typeof fetch;
}

// Turns a gateway answer into an error so reads and uploads can retry it like a dropped connection.
export async function throwOnGateway(r: Response): Promise<Response> {
  if (GATEWAY_STATUSES.has(r.status)) {
    await r.body?.cancel().catch(() => undefined);
    throw new GatewayError(r.status);
  }
  return r;
}
