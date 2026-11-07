import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resetTestDatabase } from '../helpers/db.ts';
import { startTestServer, provisionUser, type TestServer } from '../helpers/http.ts';
import { createBridge } from '../../bridge/bridge.ts';
import { fileStore } from '../../bridge/token-store.ts';

let server: TestServer;
let dir: string;
before(async () => {
  await resetTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'sim-bridge-'));
  server = await startTestServer();
});
after(() => server.close());

// Plays the browser: follows the sign-in page, posts the key, then hits the bridge's loopback callback.
function headlessBrowser(key: string) {
  return async (authUrl: URL) => {
    const a = await fetch(authUrl, { redirect: 'manual' });
    const page = await fetch(new URL(a.headers.get('location')!, server.url), { redirect: 'manual' });
    const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0]!;
    const html = await page.text();
    const field = (n: string) => html.match(new RegExp(`name="${n}" value="([^"]+)"`))![1]!;
    const post = await fetch(`${server.url}/oauth/signin`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ request: field('request'), csrf: field('csrf'), key }),
    });
    await fetch(post.headers.get('location')!);
  };
}

async function connect(store: ReturnType<typeof fileStore>, openBrowser: (u: URL) => Promise<void>) {
  const bridge = await createBridge({ server: server.url, store, openBrowser, callbackTimeoutMs: 20_000 });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(st);
  const client = new Client({ name: 'claude-code-test', version: '1' });
  await client.connect(ct);
  return { bridge, client };
}

const textOf = (r: any) => (r.content as { text: string }[])[0]!.text;

test('first run signs in through the browser; a second bridge reuses the saved tokens', async () => {
  const p = await provisionUser();
  const store = fileStore(path.join(dir, `tokens-${randomUUID()}.json`));
  let opened = 0;
  const browser = async (u: URL) => {
    opened += 1;
    await headlessBrowser(p.key)(u);
  };
  const first = await connect(store, browser);
  const tools = await first.client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['execute', 'search']);
  const who = await first.client.callTool({ name: 'execute', arguments: { code: `async () => (await api.call('whoami', {})).company_id`, reason: 'bridge check' } });
  assert.equal(JSON.parse(textOf(who)), p.companies[0]!.id);
  assert.equal(opened, 1);
  await first.bridge.close();

  const second = await connect(store, browser);
  const again = await second.client.callTool({ name: 'search', arguments: { code: `async () => Object.keys((await api.spec()).paths).length > 40`, reason: 'count operations' } });
  assert.equal(JSON.parse(textOf(again)), true);
  assert.equal(opened, 1);
  await second.bridge.close();
});

test('a local file is kept by its path through the bridge; no file is sent', async () => {
  const p = await provisionUser();
  const { bridge, client } = await connect(fileStore(path.join(dir, `tokens-${randomUUID()}.json`)), headlessBrowser(p.key));
  const where = path.join(dir, 'quotes', 'quote-from-example-steel.pdf');
  const code = `async () => {
    const d = await api.call('document_add', { kind: 'quote', title: 'Quote from Example Steel', location: ${JSON.stringify(where)},
      text: 'Unit price 2.95 USD/kg', request_key: '${`add-${randomUUID()}`}', reason: 'supplier quote attachment' });
    return (await api.call('document_get', { document_id: d.document_id })).location;
  }`;
  const r = await client.callTool({ name: 'execute', arguments: { code, reason: 'keep the quote' } });
  assert.notEqual(r.isError, true, textOf(r));
  assert.equal(JSON.parse(textOf(r)), where);
  await bridge.close();
});
