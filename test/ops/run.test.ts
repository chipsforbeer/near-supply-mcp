import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { resetTestDatabase } from '../helpers/db.ts';
import { newActor, call } from '../helpers/ops.ts';
import { runOperation } from '../../src/ops/run.ts';
import { OpError } from '../../src/ops/errors.ts';
import { registerTestOp } from '../../src/ops/catalogue.ts';
import { defineOp } from '../../src/ops/define.ts';

before(resetTestDatabase);

registerTestOp(
  defineOp({
    name: 'test_echo_write',
    summary: 'test only',
    kind: 'write',
    scope: 'write',
    input: z.object({ value: z.string() }).strict(),
    async handler(args) {
      return { value: args.value, at: new Date().toISOString() };
    },
  }),
);

const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;

test('whoami returns the session company and scopes', async () => {
  const actor = await newActor({ scopes: ['read'] });
  const me = await call(actor, 'whoami');
  assert.equal(me.company_id, actor.session.companyId);
  assert.deepEqual(me.scopes, ['read']);
  assert.match(me.email, /@example\.test$/);
});

test('unknown operation is rejected', async () => {
  const actor = await newActor();
  await assert.rejects(call(actor, 'no_such_op'), isCode('unknown_operation'));
});

test('write without write scope is forbidden', async () => {
  const actor = await newActor({ scopes: ['read'] });
  await assert.rejects(call(actor, 'test_echo_write', { value: 'x' }), isCode('forbidden'));
});

test('unknown argument keys are invalid', async () => {
  const actor = await newActor();
  await assert.rejects(call(actor, 'whoami', { surprise: 1 }), isCode('invalid_arguments'));
});

test('write without reason or request_key is invalid', async () => {
  const actor = await newActor();
  const ctx = await actor.ctx();
  await assert.rejects(runOperation('test_echo_write', { value: 'x', request_key: 'abcdefgh' }, ctx), isCode('invalid_arguments'));
  await assert.rejects(runOperation('test_echo_write', { value: 'x', reason: 'why' }, ctx), isCode('invalid_arguments'));
  await assert.rejects(runOperation('test_echo_write', { value: 'x', reason: '   ', request_key: 'abcdefgh' }, ctx), isCode('invalid_arguments'));
});

test('same request_key and args returns the saved result without writing twice', async () => {
  const actor = await newActor();
  const ctx = await actor.ctx();
  const args = { value: 'once', request_key: 'key-0001-abc', reason: 'idempotency test' };
  const first = await runOperation('test_echo_write', args, ctx);
  const second = await runOperation('test_echo_write', args, ctx);
  assert.deepEqual(second, first);
  const audit = await call(actor, 'audit_list', { limit: 50 });
  const writes = audit.items.flatMap((i: any) => i.operations).filter((o: any) => o.operation === 'test_echo_write');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].reason, 'idempotency test');
});

test('same request_key with different args is rejected', async () => {
  const actor = await newActor();
  const ctx = await actor.ctx();
  await runOperation('test_echo_write', { value: 'a', request_key: 'key-0002-abc', reason: 'r' }, ctx);
  await assert.rejects(
    runOperation('test_echo_write', { value: 'b', request_key: 'key-0002-abc', reason: 'r' }, ctx),
    isCode('request_key_reused'),
  );
});

test('operation_status reports a completed write', async () => {
  const actor = await newActor();
  await call(actor, 'test_echo_write', { value: 'v', request_key: 'key-0003-abc' });
  const status = await call(actor, 'operation_status', { request_key: 'key-0003-abc' });
  assert.equal(status.status, 'completed');
  assert.equal(status.result.value, 'v');
});

test('audit_list shows reasons and only for the caller company', async () => {
  const a = await newActor();
  const b = await newActor();
  await call(a, 'test_echo_write', { value: 'v', reason: 'restock check for malt' });
  const seenByB = await call(b, 'audit_list', { limit: 50 });
  assert.ok(!JSON.stringify(seenByB).includes('restock check for malt'));
  const seenByA = await call(a, 'audit_list', { limit: 50 });
  assert.ok(JSON.stringify(seenByA).includes('restock check for malt'));
});
