import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase, testConfig, testOwnerPool } from '../helpers/db.ts';
import { startTestServer, provisionUser, signInHeadless, refresh, callOp, type TestServer } from '../helpers/http.ts';
import { adminCommands } from '../../src/admin/commands.ts';
import { companyStarterPages } from '../../src/admin/company-setup.ts';

let server: TestServer;
before(async () => {
  await resetTestDatabase();
  server = await startTestServer();
});
after(() => server.close());

const admin = () => adminCommands(testOwnerPool(), testConfig().hmacSecret, companyStarterPages);
const events = async (where: string, args: unknown[]) =>
  (await testOwnerPool().query(`SELECT kind, user_id, company_id, client_id, api_key_id, session_id FROM auth_event WHERE ${where} ORDER BY id`, args)).rows;

async function addMember(slug: string, scopes: string): Promise<{ email: string; key: string }> {
  const email = `member-${Math.random().toString(36).slice(2, 10)}@example.test`;
  await admin().createUser({ email, displayName: 'Example Member' });
  await admin().grantMembership({ email, slug, scopes });
  const { key } = await admin().issueKey({ email, label: 'member laptop' });
  return { email, key };
}

test('a session remembers its key; revoking the key ends only that key\'s sessions', async () => {
  const p = await provisionUser();
  const second = await admin().issueKey({ email: p.email, label: 'second machine' });
  const s1 = await signInHeadless(server.url, p.key);
  const s2 = await signInHeadless(server.url, second.key);
  const rows = (await testOwnerPool().query('SELECT api_key_id FROM oauth_session WHERE user_id = (SELECT id FROM app_user WHERE email = $1) ORDER BY created_at', [p.email])).rows;
  assert.deepEqual(rows.map((r) => r.api_key_id), [p.keyId, second.keyId]);

  await admin().revokeKey({ keyId: p.keyId });
  assert.equal((await callOp(server.url, s1.accessToken!, 'whoami', {}, 'after revoke')).status, 401);
  assert.equal((await refresh(server.url, s1.clientId!, s1.refreshToken!)).status, 400);
  assert.equal((await callOp(server.url, s2.accessToken!, 'whoami', {}, 'other key')).status, 200);
  const revoked = await events(`kind IN ('key_revoked', 'session_revoked') AND api_key_id = $1`, [p.keyId]);
  assert.deepEqual(revoked.map((e) => e.kind), ['key_revoked', 'session_revoked']);
});

test('a session ends at its expiry even with a valid refresh token', async () => {
  const p = await provisionUser();
  const s = await signInHeadless(server.url, p.key);
  const row = (await testOwnerPool().query('SELECT expires_at - created_at AS life FROM oauth_session WHERE api_key_id = $1', [p.keyId])).rows[0];
  assert.equal(row.life.days, 30);
  await testOwnerPool().query(`UPDATE oauth_session SET expires_at = now() - interval '1 second' WHERE api_key_id = $1`, [p.keyId]);
  assert.equal((await callOp(server.url, s.accessToken!, 'whoami', {}, 'expired')).status, 401);
  assert.equal((await refresh(server.url, s.clientId!, s.refreshToken!)).status, 400);
});

test('sign-in events name the key, client and session; sessions record their last use', async () => {
  const p = await provisionUser();
  const s = await signInHeadless(server.url, p.key);
  await callOp(server.url, s.accessToken!, 'whoami', {}, 'use the session');
  const session = (await testOwnerPool().query('SELECT id, last_used_at FROM oauth_session WHERE api_key_id = $1', [p.keyId])).rows[0];
  assert.ok(session.last_used_at, 'last_used_at is set');
  const signin = await events(`kind IN ('signin_ok', 'token_issued') AND api_key_id = $1`, [p.keyId]);
  assert.deepEqual(signin.map((e) => [e.kind, e.company_id, e.client_id]), [
    ['signin_ok', p.companies[0]!.id, s.clientId],
    ['token_issued', p.companies[0]!.id, s.clientId],
  ]);
  assert.equal(signin[1]!.session_id, session.id);
});

test('choosing a company keeps the key on the session', async () => {
  const p = await provisionUser({ companies: 2 });
  const s = await signInHeadless(server.url, p.key, { companyId: p.companies[1]!.id });
  assert.equal(s.status, 'ok');
  const row = (await testOwnerPool().query('SELECT api_key_id, company_id FROM oauth_session WHERE api_key_id = $1', [p.keyId])).rows[0];
  assert.deepEqual([row.api_key_id, row.company_id], [p.keyId, p.companies[1]!.id]);
});

test('whoami shows the session: when it started, when it ends, which key', async () => {
  const p = await provisionUser();
  const s = await signInHeadless(server.url, p.key);
  const me = (await callOp(server.url, s.accessToken!, 'whoami', {}, 'who am I')).body.result;
  assert.equal(me.session.key_label, 'test');
  assert.ok(Date.parse(me.session.expires_at) > Date.parse(me.session.signed_in_at));
});

test('an approver sees who is signed in; other members may not', async () => {
  const p = await provisionUser();
  const buyer = await addMember(p.companies[0]!.slug, 'read,write');
  const owner = await signInHeadless(server.url, p.key);
  const b = await signInHeadless(server.url, buyer.key);
  await callOp(server.url, b.accessToken!, 'whoami', {}, 'buyer works');

  const r = await callOp(server.url, owner.accessToken!, 'users_list', {}, 'who has access');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const users = r.body.result.users as any[];
  assert.deepEqual(users.map((u) => u.email).sort(), [buyer.email, p.email].sort());
  const bu = users.find((u) => u.email === buyer.email);
  assert.deepEqual(bu.scopes, ['read', 'write']);
  assert.equal(bu.active_sessions.length, 1);
  assert.equal(bu.active_sessions[0].client_name, 'test-client');
  assert.ok(bu.active_sessions[0].last_used_at);
  assert.deepEqual(bu.keys.map((k: any) => [k.label, k.revoked_at]), [['member laptop', null]]);
  assert.ok(!JSON.stringify(r.body).includes('hmac'), 'no key or token material');

  const refused = await callOp(server.url, b.accessToken!, 'users_list', {}, 'buyer tries');
  assert.equal(refused.status, 403);
});

test('auth events: an approver sees this company\'s sign-ins, never another company\'s', async () => {
  const a = await provisionUser();
  const other = await provisionUser();
  const sa = await signInHeadless(server.url, a.key);
  await signInHeadless(server.url, other.key);
  const r = await callOp(server.url, sa.accessToken!, 'auth_events_list', { limit: 50 }, 'recent sign-ins');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const items = r.body.result.items as any[];
  assert.ok(items.some((e) => e.kind === 'signin_ok' && e.user_email === a.email));
  assert.ok(!JSON.stringify(items).includes(other.email), 'no other company\'s events');
  assert.ok(items.every((e) => e.key_label === null || e.key_label === 'test'));
});
