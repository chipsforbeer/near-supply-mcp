import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/http/app.ts';
import { adminCommands } from '../../src/admin/commands.ts';
import { companyStarterPages } from '../../src/admin/company-setup.ts';
import { testConfig, testDb, testOwnerPool } from './db.ts';

export type TestServer = { url: string; close(): Promise<void> };

export async function startTestServer(): Promise<TestServer> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const cfg = { ...testConfig(), publicOrigin: `http://127.0.0.1:${port}`, isLocalOrigin: true };
  const app = createApp({ cfg, db: testDb(), signInLimitPerMinute: 1000 });
  server.on('request', app);
  return {
    url: cfg.publicOrigin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type Provisioned = { email: string; key: string; keyId: string; companies: { id: string; slug: string; name: string }[] };

export async function provisionUser(opts: { companies?: number; scopes?: string } = {}): Promise<Provisioned> {
  const admin = adminCommands(testOwnerPool(), testConfig().hmacSecret, companyStarterPages);
  const email = `buyer-${randomUUID().slice(0, 8)}@example.test`;
  await admin.createUser({ email, displayName: 'Example Buyer' });
  const companies: Provisioned['companies'] = [];
  for (let i = 0; i < (opts.companies ?? 1); i += 1) {
    const slug = `co-${randomUUID().slice(0, 8)}`;
    const name = `Example Co ${i + 1} ${slug}`;
    const c = await admin.createCompany({ name, slug });
    await admin.grantMembership({ email, slug, scopes: opts.scopes ?? 'read,write,approve' });
    companies.push({ id: c.id, slug, name });
  }
  const { key, keyId } = await admin.issueKey({ email, label: 'test' });
  return { email, key, keyId, companies };
}

export type SignInResult = {
  status: 'ok' | 'refused';
  httpStatus: number;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
};

const REDIRECT = 'http://127.0.0.1:53682/callback';

export async function registerClient(url: string, redirectUris = [REDIRECT], clientName = 'test-client'): Promise<Response> {
  return fetch(`${url}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: redirectUris,
      client_name: clientName,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
}

function between(html: string, name: string): string {
  const m = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  if (!m?.[1]) throw new Error(`No ${name} field in page`);
  return m[1];
}

// Walks the whole browser flow with fetch: register, authorize, sign-in page, token exchange.
export async function signInHeadless(
  url: string,
  key: string,
  opts: { companyId?: string; clientName?: string; resource?: string } = {},
): Promise<SignInResult> {
  const reg = await registerClient(url, [REDIRECT], opts.clientName);
  const client = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(`${url}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    scope: 'read write approve',
    resource: opts.resource ?? `${url}/mcp`,
  }).toString();
  const a = await fetch(authorize, { redirect: 'manual' });
  const location = a.headers.get('location') ?? '';
  if (!location.startsWith('/oauth/signin')) return { status: 'refused', httpStatus: a.status };

  const page = await fetch(new URL(location, url), { redirect: 'manual' });
  const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const html = await page.text();
  const request = between(html, 'request');
  let form = new URLSearchParams({ request, csrf: between(html, 'csrf'), key });
  let post = await fetch(`${url}/oauth/signin`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: form,
  });
  if (post.status === 200) {
    // Company choice page.
    const choice = await post.text();
    const nextCookie = (post.headers.get('set-cookie') ?? '').split(';')[0] ?? cookie;
    form = new URLSearchParams({
      request,
      csrf: between(choice, 'csrf'),
      ticket: between(choice, 'ticket'),
      company: opts.companyId ?? '',
    });
    post = await fetch(`${url}/oauth/signin`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: nextCookie },
      body: form,
    });
  }
  if (post.status !== 302) return { status: 'refused', httpStatus: post.status };
  const back = new URL(post.headers.get('location') ?? '');
  if (back.searchParams.get('state') !== 'st-1') throw new Error('state was not returned');
  const code = back.searchParams.get('code') ?? '';
  const tok = await fetch(`${url}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      resource: `${url}/mcp`,
    }),
  });
  if (tok.status !== 200) return { status: 'refused', httpStatus: tok.status };
  const t = (await tok.json()) as { access_token: string; refresh_token: string };
  return { status: 'ok', httpStatus: 200, accessToken: t.access_token, refreshToken: t.refresh_token, clientId: client.client_id };
}

export async function refresh(url: string, clientId: string, refreshToken: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${url}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, resource: `${url}/mcp` }),
  });
  return { status: r.status, body: await r.json() };
}

export async function callOp(url: string, token: string, name: string, args: unknown, reason?: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${url}/api/v1/ops/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(reason === undefined ? { args } : { reason, args }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
