import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resetTestDatabase } from '../helpers/db.ts';
import { startTestServer, provisionUser, type TestServer } from '../helpers/http.ts';
import { createBridge } from '../../bridge/bridge.ts';
import { fileStore } from '../../bridge/token-store.ts';
import { failedBeforeSending, isTransient, retrying, retryingFetch } from '../../bridge/retry.ts';

const NO_WAIT = [0, 0, 0];
const notSent = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
const lostReply = () => new TypeError('fetch failed', { cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) });

test('which failures count as "never sent" and which as transient', () => {
  assert.equal(failedBeforeSending(notSent()), true);
  assert.equal(failedBeforeSending(lostReply()), false);
  assert.equal(failedBeforeSending(new Error('fetch failed')), false);
  assert.equal(isTransient(lostReply()), true);
  assert.equal(isTransient(new McpError(ErrorCode.RequestTimeout, 'timed out')), true);
  assert.equal(isTransient(new StreamableHTTPError(522, 'origin timed out')), true);
  assert.equal(isTransient(new StreamableHTTPError(400, 'bad request')), false);
  assert.equal(isTransient(new McpError(ErrorCode.InvalidParams, 'bad')), false);
});

test('retrying stops at the attempt limit and never retries what it should not', async () => {
  let calls = 0;
  await assert.rejects(retrying('x', async () => { calls += 1; throw notSent(); }, failedBeforeSending, NO_WAIT, () => undefined), /fetch failed/);
  assert.equal(calls, 4);
  calls = 0;
  await assert.rejects(retrying('x', async () => { calls += 1; throw lostReply(); }, failedBeforeSending, NO_WAIT, () => undefined), /fetch failed/);
  assert.equal(calls, 1);
});

test('retryingFetch re-sends a request that never left, with the same body', async () => {
  const bodies: unknown[] = [];
  let calls = 0;
  const base = (async (_u: unknown, init?: RequestInit) => {
    calls += 1;
    bodies.push(init?.body);
    if (calls < 3) throw notSent();
    return new Response('ok');
  }) as typeof fetch;
  const r = await retryingFetch(base, NO_WAIT, () => undefined)('http://127.0.0.1:1/x', { method: 'POST', body: '{"a":1}' });
  assert.equal(await r.text(), 'ok');
  assert.deepEqual(bodies, ['{"a":1}', '{"a":1}', '{"a":1}']);
  calls = 0;
  const once = (async () => { calls += 1; throw lostReply(); }) as typeof fetch;
  await assert.rejects(retryingFetch(once, NO_WAIT, () => undefined)('http://127.0.0.1:1/x', { method: 'POST', body: '{}' }));
  assert.equal(calls, 1);
});

// ---- Through the real bridge and a real server, over a deliberately flaky network ----

let server: TestServer;
let dir: string;
before(async () => {
  await resetTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'sim-retry-'));
  server = await startTestServer();
});
after(() => server.close());

type Fault = { match: (url: string, body: string) => boolean; mode: 'not_sent' | 'lost_reply'; times: number };

// Fails the matching requests as configured: either before sending, or after the server has
// answered (the reply is thrown away), the case where a retry could repeat a change.
function flakyFetch(faults: Fault[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === 'string' ? init.body : '';
    const f = faults.find((x) => x.times > 0 && x.match(url, body));
    if (!f) return fetch(input, init);
    f.times -= 1;
    if (f.mode === 'not_sent') throw notSent();
    const r = await fetch(input, init);
    await r.arrayBuffer().catch(() => undefined);
    throw lostReply();
  }) as typeof fetch;
}

function headlessBrowser(key: string) {
  return async (authUrl: URL) => {
    const a = await fetch(authUrl, { redirect: 'manual' });
    const page = await fetch(new URL(a.headers.get('location')!, server.url), { redirect: 'manual' });
    const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0]!;
    const html = await page.text();
    const field = (n: string) => html.match(new RegExp(`name="${n}" value="([^"]+)"`))![1]!;
    const post = await fetch(`${server.url}/oauth/signin`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ request: field('request'), csrf: field('csrf'), key }),
    });
    await fetch(post.headers.get('location')!);
  };
}

async function bridgeWith(faults: Fault[]) {
  const p = await provisionUser();
  const log: string[] = [];
  const bridge = await createBridge({
    server: server.url,
    store: fileStore(path.join(dir, `tokens-${randomUUID()}.json`)),
    openBrowser: headlessBrowser(p.key),
    callbackTimeoutMs: 20_000,
    fetch: flakyFetch(faults),
    retryDelaysMs: NO_WAIT,
    log: (l) => log.push(l),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(st);
  const client = new Client({ name: 'retry-test', version: '1' });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, text: (r.content as { text: string }[])[0]!.text };
  };
  // How many times the server really ran tool calls with this reason (from its audit log).
  const ranTimes = async (reason: string) => {
    const r = await call('execute', { code: `async () => (await api.call('audit_list', { limit: 200 })).items.map(i => i.reason)`, reason: 'count runs' });
    return (JSON.parse(r.text) as string[]).filter((x) => x === reason).length;
  };
  // Every fault set up must actually have happened, or the test proves nothing.
  const done = async () => {
    assert.deepEqual(faults.map((f) => f.times), faults.map(() => 0), 'all faults were triggered');
    await bridge.close();
  };
  return { call, ranTimes, log, done };
}

const toolCall = (tool: string) => (url: string, body: string) => url.endsWith('/mcp') && body.includes('"tools/call"') && body.includes(`"name":"${tool}"`);

test('sign-in and execute get through when connections fail before sending', async () => {
  const b = await bridgeWith([
    { match: (u) => u.endsWith('/token'), mode: 'not_sent', times: 1 },
    { match: toolCall('execute'), mode: 'not_sent', times: 2 },
  ]);
  const r = await b.call('execute', { code: `async () => (await api.call('whoami', {})).scopes`, reason: 'retry before sending' });
  assert.equal(r.isError, false, r.text);
  assert.equal(await b.ranTimes('retry before sending'), 1);
  assert.ok(b.log.some((l) => /retrying/.test(l)), 'retries are logged');
  await b.done();
});

test('execute is never retried once its request may have reached the server', async () => {
  const b = await bridgeWith([{ match: toolCall('execute'), mode: 'lost_reply', times: 1 }]);
  const r = await b.call('execute', { code: `async () => 1`, reason: 'lost reply' });
  assert.equal(r.isError, true);
  assert.match(r.text, /fetch failed/);
  assert.equal(await b.ranTimes('lost reply'), 1, 'it ran on the server exactly once');
  await b.done();
});

test('search is retried even when the reply was lost (it only reads)', async () => {
  const b = await bridgeWith([{ match: toolCall('search'), mode: 'lost_reply', times: 2 }]);
  const r = await b.call('search', { code: `async () => Object.keys((await api.spec()).paths).length`, reason: 'lost search reply' });
  assert.equal(r.isError, false, r.text);
  assert.ok(Number(r.text.match(/\d+/)?.[0]) > 60);
  await b.done();
});
