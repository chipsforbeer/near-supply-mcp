// Headless OAuth sign-in, by default for the LOCAL demo supplier server only (fictional data, demo keys):
// register → authorize → sign-in form (CSRF cookie) → token. Mirrors the browser flow the teammate's
// own tests use, so the e2e test can act as both the approver and the payment MCP without a browser.
import { createHash, randomBytes } from 'node:crypto';
import type { StoredAuth } from '../../src/supply/auth.ts';

const REDIRECT = 'http://127.0.0.1:53999/callback';
const field = (html: string, name: string) => {
  const m = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  if (!m?.[1]) throw new Error(`sign-in page has no ${name} field`);
  return m[1];
};

// allowRemote: only for scripts/seed-demo-brewery.ts, which a person runs on purpose with their own key.
export async function signInHeadless(base: string, key: string, scope: string, opts: { allowRemote?: boolean } = {}): Promise<StoredAuth> {
  if (!opts.allowRemote && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error('headless sign-in is for the local demo server only');
  const reg = await fetch(`${base}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'near-payment-mcp-e2e', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope }),
  });
  const client = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL(`${base}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, state: 'e2e',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    scope, resource: `${base}/mcp`,
  }).toString();
  const a = await fetch(authorize, { redirect: 'manual' });
  const page = await fetch(new URL(a.headers.get('location') ?? '', base), { redirect: 'manual' });
  const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const html = await page.text();
  const post = await fetch(`${base}/oauth/signin`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ request: field(html, 'request'), csrf: field(html, 'csrf'), key }),
  });
  if (post.status !== 302) throw new Error(`sign-in refused (HTTP ${post.status})`);
  const code = new URL(post.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const tok = await fetch(`${base}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: `${base}/mcp` }),
  });
  if (tok.status !== 200) throw new Error(`token exchange failed (HTTP ${tok.status})`);
  return { client: { client_id: client.client_id, redirect_uris: [REDIRECT] } as StoredAuth['client'], tokens: await tok.json(), obtainedAt: Date.now() };
}
