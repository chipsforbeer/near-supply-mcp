import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { TokenStore } from './token-store.ts';

export const BRIDGE_CLIENT_NAME = 'supplier-inventory-bridge';

// Tokens live in the token store; the code verifier and redirect URL only for one sign-in.
export class BridgeOAuthProvider implements OAuthClientProvider {
  private verifier = '';
  private redirect = 'http://127.0.0.1:33418/callback';
  private readonly store: TokenStore;
  private readonly openBrowser: (url: URL) => Promise<void>;

  constructor(store: TokenStore, openBrowser: (url: URL) => Promise<void>) {
    this.store = store;
    this.openBrowser = openBrowser;
  }

  setRedirectUrl(url: string): void {
    this.redirect = url;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: BRIDGE_CLIENT_NAME,
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'read write approve',
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.store.load()).client;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const cur = await this.store.load();
    const slim = { client_id: info.client_id, client_id_issued_at: info.client_id_issued_at, redirect_uris: (info as { redirect_uris?: string[] }).redirect_uris, token_endpoint_auth_method: 'none' };
    await this.store.save({ ...cur, client: slim as OAuthClientInformationMixed });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.load()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const cur = await this.store.load();
    await this.store.save({ ...cur, tokens, obtainedAt: Date.now() });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.openBrowser(url);
  }

  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }

  codeVerifier(): string {
    return this.verifier;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const cur = await this.store.load();
    if (scope === 'all') await this.store.save({});
    else if (scope === 'client') await this.store.save({ ...cur, client: undefined });
    else if (scope === 'tokens') await this.store.save({ ...cur, tokens: undefined, obtainedAt: undefined });
  }
}

// One-shot loopback server that receives ?code= from the browser after sign-in.
export async function callbackServer(timeoutMs: number): Promise<{ url: string; code: Promise<string>; close: () => void }> {
  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  code.catch(() => undefined);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const c = u.searchParams.get('code');
    const err = u.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(c ? '<p>Signed in. You can close this tab and go back to Claude.</p>' : '<p>Sign-in did not complete. Go back to Claude and try again.</p>');
    if (c) resolveCode(c);
    else rejectCode(new Error(`Sign-in failed: ${err ?? 'no code returned'}`));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const timer = setTimeout(() => rejectCode(new Error('Sign-in timed out after 5 minutes.')), timeoutMs);
  return {
    url: `http://127.0.0.1:${port}/callback`,
    code,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

// Keeps a fresh access token. All refreshes go through one queue so a refresh token is never
// used twice (the server revokes the whole session if that happens).
export class Session {
  private queue: Promise<unknown> = Promise.resolve();
  readonly provider: BridgeOAuthProvider;
  readonly mcpUrl: URL;
  private readonly store: TokenStore;
  private readonly callbackTimeoutMs: number;
  private readonly fetchFn: typeof fetch | undefined;

  constructor(provider: BridgeOAuthProvider, store: TokenStore, mcpUrl: URL, callbackTimeoutMs = 5 * 60_000, fetchFn?: typeof fetch) {
    this.provider = provider;
    this.store = store;
    this.mcpUrl = mcpUrl;
    this.callbackTimeoutMs = callbackTimeoutMs;
    this.fetchFn = fetchFn;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // Signs in through the browser when there are no usable tokens.
  ensure(force = false): Promise<string> {
    return this.serial(async () => {
      const saved = await this.store.load();
      const fresh = saved.tokens && saved.obtainedAt && saved.tokens.expires_in
        ? saved.obtainedAt + (saved.tokens.expires_in - 120) * 1000 > Date.now()
        : false;
      if (saved.tokens && fresh && !force) return saved.tokens.access_token;
      const cb = await callbackServer(this.callbackTimeoutMs);
      try {
        this.provider.setRedirectUrl(cb.url);
        const first = await auth(this.provider, { serverUrl: this.mcpUrl, fetchFn: this.fetchFn });
        if (first === 'REDIRECT') {
          const code = await cb.code;
          await auth(this.provider, { serverUrl: this.mcpUrl, authorizationCode: code, fetchFn: this.fetchFn });
        }
      } finally {
        cb.close();
      }
      const t = (await this.store.load()).tokens;
      if (!t) throw new Error('Sign-in did not produce tokens.');
      return t.access_token;
    });
  }
}
