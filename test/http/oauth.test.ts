import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase, testConfig, testOwnerPool } from '../helpers/db.ts';
import { startTestServer, provisionUser, signInHeadless, refresh, callOp, registerClient, type TestServer } from '../helpers/http.ts';
import { adminCommands } from '../../src/admin/commands.ts';

let server: TestServer;
before(async () => {
  await resetTestDatabase();
  server = await startTestServer();
});
after(() => server.close());

test('metadata is published for the MCP resource', async () => {
  const r = await fetch(`${server.url}/.well-known/oauth-authorization-server`);
  assert.equal(r.status, 200);
  const meta = await r.json();
  assert.equal(meta.issuer, `${server.url}/`);
  const pr = await fetch(`${server.url}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(pr.status, 200);
});

test('non-loopback redirect URIs are refused at registration', async () => {
  const r = await registerClient(server.url, ['https://evil.example.com/cb']);
  assert.equal(r.status, 400);
});

test('a valid key signs in and the token works', async () => {
  const p = await provisionUser();
  const s = await signInHeadless(server.url, p.key);
  assert.equal(s.status, 'ok');
  const me = await callOp(server.url, s.accessToken!, 'whoami', {}, 'check identity');
  assert.equal(me.status, 200);
  assert.equal(me.body.result.company_id, p.companies[0]!.id);
  assert.equal(me.body.result.email, p.email);
});

test('a wrong or revoked key is refused', async () => {
  const p = await provisionUser();
  const wrong = await signInHeadless(server.url, `sik_${'A'.repeat(43)}`);
  assert.equal(wrong.status, 'refused');
  assert.equal(wrong.httpStatus, 401);
  await adminCommands(testOwnerPool(), testConfig().hmacSecret).revokeKey({ keyId: p.keyId });
  const revoked = await signInHeadless(server.url, p.key);
  assert.equal(revoked.status, 'refused');
});

test('a wrong resource is refused', async () => {
  const p = await provisionUser();
  const s = await signInHeadless(server.url, p.key, { resource: 'http://127.0.0.1:1/other' });
  assert.equal(s.status, 'refused');
});

test('refresh rotates tokens; reusing an old refresh token revokes the session', async () => {
  const p = await provisionUser();
  const s = await signInHeadless(server.url, p.key);
  const r1 = await refresh(server.url, s.clientId!, s.refreshToken!);
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.access_token, s.accessToken);
  assert.notEqual(r1.body.refresh_token, s.refreshToken);
  assert.equal((await callOp(server.url, s.accessToken!, 'whoami', {}, 'old token')).status, 401);
  assert.equal((await callOp(server.url, r1.body.access_token, 'whoami', {}, 'new token')).status, 200);

  const reuse = await refresh(server.url, s.clientId!, s.refreshToken!);
  assert.equal(reuse.status, 400);
  assert.equal(reuse.body.error, 'invalid_grant');
  assert.equal((await callOp(server.url, r1.body.access_token, 'whoami', {}, 'after reuse')).status, 401);
  assert.equal((await refresh(server.url, s.clientId!, r1.body.refresh_token)).status, 400);
});

test('a user in two companies chooses one and the token is bound to it', async () => {
  const p = await provisionUser({ companies: 2 });
  const second = p.companies[1]!;
  const s = await signInHeadless(server.url, p.key, { companyId: second.id });
  assert.equal(s.status, 'ok');
  const me = await callOp(server.url, s.accessToken!, 'whoami', {}, 'which company');
  assert.equal(me.body.result.company_id, second.id);
});

test('scopes follow the membership', async () => {
  const p = await provisionUser({ scopes: 'read' });
  const s = await signInHeadless(server.url, p.key);
  const me = await callOp(server.url, s.accessToken!, 'whoami', {}, 'scopes');
  assert.deepEqual(me.body.result.scopes, ['read']);
});

test('disabling a user stops their tokens', async () => {
  const p = await provisionUser();
  const s = await signInHeadless(server.url, p.key);
  await adminCommands(testOwnerPool(), testConfig().hmacSecret).disableUser({ email: p.email });
  assert.equal((await callOp(server.url, s.accessToken!, 'whoami', {}, 'disabled')).status, 401);
});
