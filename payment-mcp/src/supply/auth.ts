// OAuth sign-in to the supplier-inventory server (MCP OAuth: dynamic registration, PKCE, loopback redirect).
// Same flow as the teammate's bridge (supplier-inventory-mcp/bridge/remote.ts), but:
//  - asks for "read write" only, passed explicitly to auth(): the SDK otherwise prefers the server's
//    advertised scopes_supported (read write approve) over clientMetadata.scope. The server grants
//    requested ∩ member scopes; login() also refuses and revokes any session granted "approve";
//  - only `login` may open a browser; the running MCP server refreshes silently or fails with a clear error.

import http from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

export const CLIENT_NAME = 'near-payment-mcp';
export const SCOPES = 'read write';

export type StoredAuth = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; obtainedAt?: number };

export class TokenFile {
  readonly path: string;
  constructor(filePath: string) {
    this.path = path.resolve(filePath);
  }
  async load(): Promise<StoredAuth> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as StoredAuth;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
  }
  async save(v: StoredAuth): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, JSON.stringify(v), { mode: 0o600 });
    await chmod(this.path, 0o600).catch(() => undefined);
  }
}

export class NotSignedIn extends Error {
  constructor(detail: string) {
    super(`Not signed in to the supplier server (${detail}). Run \`npm run login\` in the payment MCP folder.`);
  }
}

class Provider implements OAuthClientProvider {
  private verifier = '';
  redirect = 'http://127.0.0.1:33419/callback';
  private readonly store: TokenFile;
  private readonly interactive: ((url: URL) => Promise<void>) | null;
  constructor(store: TokenFile, interactive: ((url: URL) => Promise<void>) | null) {
    this.store = store;
    this.interactive = interactive;
  }
  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CLIENT_NAME,
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPES,
    };
  }
  async clientInformation() {
    return (await this.store.load()).client;
  }
  async saveClientInformation(info: OAuthClientInformationMixed) {
    const cur = await this.store.load();
    await this.store.save({ ...cur, client: info });
  }
  async tokens() {
    return (await this.store.load()).tokens;
  }
  async saveTokens(tokens: OAuthTokens) {
    const cur = await this.store.load();
    await this.store.save({ ...cur, tokens, obtainedAt: Date.now() });
  }
  async redirectToAuthorization(url: URL) {
    if (!this.interactive) throw new NotSignedIn('the session expired or was revoked');
    await this.interactive(url);
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const cur = await this.store.load();
    if (scope === 'all') await this.store.save({});
    else if (scope === 'client') await this.store.save({ ...cur, client: undefined });
    else if (scope === 'tokens') await this.store.save({ ...cur, tokens: undefined, obtainedAt: undefined });
  }
}

async function callbackServer(timeoutMs: number) {
  let ok!: (c: string) => void;
  let fail!: (e: Error) => void;
  const code = new Promise<string>((a, b) => ((ok = a), (fail = b)));
  code.catch(() => undefined);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/callback') return void res.writeHead(404).end();
    const c = u.searchParams.get('code');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(c ? '<p>Payment MCP signed in. You can close this tab.</p>' : '<p>Sign-in did not complete.</p>');
    if (c) ok(c);
    else fail(new Error(`Sign-in failed: ${u.searchParams.get('error') ?? 'no code returned'}`));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const timer = setTimeout(() => fail(new Error('Sign-in timed out.')), timeoutMs);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`,
    code,
    close: () => (clearTimeout(timer), server.close()),
  };
}

/** Keeps a fresh access token. Refreshes are serialised: the server revokes a session whose refresh token is reused. */
export class SupplyAuth {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly store: TokenFile;
  private readonly mcpUrl: URL;
  private readonly fetchFn: typeof fetch;
  constructor(store: TokenFile, mcpUrl: URL, fetchFn: typeof fetch = fetch) {
    this.store = store;
    this.mcpUrl = mcpUrl;
    this.fetchFn = fetchFn;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Non-interactive: returns a valid access token, refreshing if needed, or throws NotSignedIn. */
  accessToken(forceRefresh = false): Promise<string> {
    return this.serial(async () => {
      const saved = await this.store.load();
      if (!saved.tokens) throw new NotSignedIn('no saved session');
      const fresh = saved.obtainedAt && saved.tokens.expires_in
        ? saved.obtainedAt + (saved.tokens.expires_in - 120) * 1000 > Date.now()
        : false;
      if (fresh && !forceRefresh) return saved.tokens.access_token;
      if (!saved.tokens.refresh_token) throw new NotSignedIn('no refresh token');
      const provider = new Provider(this.store, null);
      const r = await auth(provider, { serverUrl: this.mcpUrl, scope: SCOPES, fetchFn: this.fetchFn });
      if (r !== 'AUTHORIZED') throw new NotSignedIn('refresh failed');
      const t = (await this.store.load()).tokens;
      if (!t) throw new NotSignedIn('refresh produced no tokens');
      return t.access_token;
    });
  }

  /** Interactive browser sign-in; only the `login` command calls this. */
  async login(openBrowser: (url: URL) => Promise<void>, timeoutMs = 5 * 60_000): Promise<void> {
    await this.revoke(); // end the previous session on the server, not just locally
    await this.store.save({}); // fresh client + session each login
    const cb = await callbackServer(timeoutMs);
    try {
      const provider = new Provider(this.store, openBrowser);
      provider.redirect = cb.url;
      const first = await auth(provider, { serverUrl: this.mcpUrl, scope: SCOPES, fetchFn: this.fetchFn });
      if (first === 'REDIRECT') {
        await auth(provider, { serverUrl: this.mcpUrl, scope: SCOPES, authorizationCode: await cb.code, fetchFn: this.fetchFn });
      }
    } finally {
      cb.close();
    }
    const t = (await this.store.load()).tokens;
    if (!t) throw new Error('Sign-in did not produce tokens.');
    const granted = (t.scope ?? '').split(/\s+/).filter(Boolean);
    if (granted.includes('approve') || !granted.includes('write')) {
      await this.revoke();
      await this.store.save({});
      throw new Error(`Refusing a session with scopes [${granted.join(' ')}]: the payment MCP must have read+write and never approve. Session revoked.`);
    }
  }

  /** Revoke the saved session at the server (refresh token revocation ends the whole session). */
  async revoke(): Promise<boolean> {
    const saved = await this.store.load();
    const token = saved.tokens?.refresh_token ?? saved.tokens?.access_token;
    if (!token || !saved.client) return false;
    const res = await this.fetchFn(new URL('/revoke', this.mcpUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: saved.client.client_id }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  }
}
