import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox, DEFAULT_LIMITS, Gate } from '../../src/mcp/sandbox.ts';
import { OpError } from '../../src/ops/errors.ts';

const host = {
  spec: async () => ({ ok: true }),
  call: async (op: string, args: unknown) => {
    if (op === 'boom') throw new OpError('not_found', 'Thing not found.');
    return { op, args };
  },
};

test('returns JSON of the async function result', async () => {
  const r = await runInSandbox('async () => ({ a: 1 })', host, DEFAULT_LIMITS);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(JSON.parse(r.text), { a: 1 });
});

test('api.call reaches the host and counts calls', async () => {
  const r = await runInSandbox(`async () => await api.call('x', { n: 2 })`, host, DEFAULT_LIMITS);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.calls, 1);
  assert.deepEqual(JSON.parse(r.text), { op: 'x', args: { n: 2 } });
});

test('host errors arrive as catchable errors with the public code', async () => {
  const r = await runInSandbox(
    `async () => { try { await api.call('boom', {}); } catch (e) { return e.message; } }`, host, DEFAULT_LIMITS);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(JSON.parse(r.text), 'not_found: Thing not found.');
});

test('no network, require, process or fetch inside', async () => {
  const r = await runInSandbox(
    `async () => [typeof fetch, typeof require, typeof process, typeof XMLHttpRequest, typeof __host_call]`,
    host, DEFAULT_LIMITS);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(JSON.parse(r.text), ['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
});

test('infinite loop is stopped by the time limit', async () => {
  const r = await runInSandbox('async () => { while (true) {} }', host, { ...DEFAULT_LIMITS, timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /time limit/);
});

test('memory limit is enforced', async () => {
  const r = await runInSandbox(
    `async () => new Array(50000000).fill(0).length`,
    host, { ...DEFAULT_LIMITS, memoryBytes: 8 * 1024 * 1024 });
  assert.equal(r.ok, false);
});

test('call cap is enforced', async () => {
  const r = await runInSandbox(`async () => { for (let i = 0; i < 30; i++) await api.call('x', {}); }`,
    host, { ...DEFAULT_LIMITS, maxCalls: 25 });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /25/);
});

test('oversized code is rejected before running', async () => {
  const r = await runInSandbox('async () => 1 //' + 'x'.repeat(40000), host, DEFAULT_LIMITS);
  assert.equal(r.ok, false);
});

test('long results are truncated with a marker', async () => {
  const r = await runInSandbox(`async () => 'y'.repeat(50000)`, host, DEFAULT_LIMITS);
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.text.length < 24200);
  assert.match(r.text, /\[truncated: \d+ more characters\]$/);
});

test('search mode has no api.call', async () => {
  const r = await runInSandbox(`async () => typeof api.call`, { spec: host.spec }, DEFAULT_LIMITS);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(JSON.parse(r.text), 'undefined');
});

test('syntax errors are reported, not thrown', async () => {
  const r = await runInSandbox('async () => {', host, DEFAULT_LIMITS);
  assert.equal(r.ok, false);
});

test('gate limits concurrency and times out waiters', async () => {
  const gate = new Gate(1, 50);
  let release!: () => void;
  const first = gate.run(() => new Promise<void>((r) => { release = r; }));
  await assert.rejects(gate.run(async () => 1), (e: unknown) => e instanceof OpError && e.code === 'limit_exceeded');
  release();
  await first;
  assert.equal(await gate.run(async () => 2), 2);
});
