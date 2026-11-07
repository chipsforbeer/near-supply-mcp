import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resetTestDatabase, testOwnerPool, testConfig } from '../helpers/db.ts';
import { adminCommands, parseScopes } from '../../src/admin/commands.ts';
import { API_KEY_PATTERN, generateApiKey, hmac } from '../../src/auth/keys.ts';

before(resetTestDatabase);

test('keys have the expected format and differ', () => {
  const a = generateApiKey();
  const b = generateApiKey();
  assert.match(a, API_KEY_PATTERN);
  assert.notEqual(a, b);
});

test('hmac is stable per secret and differs across secrets', () => {
  assert.equal(hmac('s'.repeat(32), 'v'), hmac('s'.repeat(32), 'v'));
  assert.notEqual(hmac('s'.repeat(32), 'v'), hmac('t'.repeat(32), 'v'));
});

test('scopes must be known and include read', () => {
  assert.deepEqual(parseScopes('read,write'), ['read', 'write']);
  assert.throws(() => parseScopes('read,admin'), /Unknown scope/);
  assert.throws(() => parseScopes('write'), /read scope/);
});

test('provisioning stores only the key HMAC and can revoke it', async () => {
  const owner = testOwnerPool();
  const admin = adminCommands(owner, testConfig().hmacSecret);
  const slug = `t-${randomUUID().slice(0, 8)}`;
  await admin.createCompany({ name: 'Example Metalworks', slug });
  const email = `buyer-${randomUUID().slice(0, 8)}@example.test`;
  await admin.createUser({ email, displayName: 'Example Buyer' });
  await admin.grantMembership({ email, slug, scopes: 'read,write' });
  const { keyId, key } = await admin.issueKey({ email, label: 'laptop' });
  const row = (await owner.query('SELECT key_hmac, revoked_at FROM api_key WHERE id = $1', [keyId])).rows[0];
  assert.notEqual(row.key_hmac, key);
  assert.equal(row.key_hmac, hmac(testConfig().hmacSecret, key));
  assert.equal(row.revoked_at, null);
  await admin.revokeKey({ keyId });
  const after = (await owner.query('SELECT revoked_at FROM api_key WHERE id = $1', [keyId])).rows[0];
  assert.ok(after.revoked_at);
  await assert.rejects(admin.revokeKey({ keyId }), /No active key/);
});

test('company creation runs the follow-up hook', async () => {
  const owner = testOwnerPool();
  let called = '';
  const admin = adminCommands(owner, testConfig().hmacSecret, async (_o, id) => { called = id; });
  const c = await admin.createCompany({ name: 'Hooked', slug: `h-${randomUUID().slice(0, 8)}` });
  assert.equal(called, c.id);
});
