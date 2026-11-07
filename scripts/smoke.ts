import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createBridge } from '../bridge/bridge.ts';
import { fileStore } from '../bridge/token-store.ts';

// Smoke test of a running server through the real bridge, the way Claude Code uses it: key
// sign-in (OAuth), search, execute, and a document kept by its location (the server stores no
// files). It adds one small "smoke test" document to the company, once; later runs find it again.
// The API key comes from the SMOKE_KEY environment variable and is never printed.
// Usage: SMOKE_KEY=... npm run smoke -- --server http://127.0.0.1:8790

const i = process.argv.indexOf('--server');
const server = i >= 0 ? process.argv[i + 1] : undefined;
const key = process.env.SMOKE_KEY ?? '';
if (!server || !key) {
  console.error('Usage: SMOKE_KEY=<api key> npm run smoke -- --server <url>');
  process.exit(2);
}

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures += 1;
};

const dir = await mkdtemp(path.join(tmpdir(), 'sim-smoke-'));
const origin = new URL(server).origin;
const bridge = await createBridge({
  server: origin,
  store: fileStore(path.join(dir, 'tokens.json')),
  callbackTimeoutMs: 120_000,
  // Stands in for the person at the browser: opens the sign-in page and types the key.
  // Each step is checked, so a failure says where it happened.
  openBrowser: async (authUrl) => {
    const a = await fetch(authUrl, { redirect: 'manual' });
    const signin = a.headers.get('location');
    if (a.status !== 302 || !signin) throw new Error(`authorize: HTTP ${a.status}`);
    const page = await fetch(new URL(signin, origin), { redirect: 'manual' });
    if (page.status !== 200) throw new Error(`sign-in page: HTTP ${page.status}`);
    const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const html = await page.text();
    const field = (n: string) => {
      const v = html.match(new RegExp(`name="${n}" value="([^"]+)"`))?.[1];
      if (!v) throw new Error(`sign-in page: no ${n} field`);
      return v;
    };
    const post = await fetch(`${origin}/oauth/signin`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ request: field('request'), csrf: field('csrf'), key }),
    });
    const next = post.headers.get('location');
    if (post.status !== 302 || !next) throw new Error(`sign-in refused (HTTP ${post.status})`);
    await fetch(next);
  },
});
const [ct, st] = InMemoryTransport.createLinkedPair();
await bridge.server.connect(st);
const client = new Client({ name: 'smoke', version: '1' });
await client.connect(ct);

// Generous per-call limit: the first call includes the whole sign-in, which on a slow
// connection takes longer than the client's default of 60 seconds.
async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 180_000 });
  const text = (r.content as { text: string }[])[0]?.text ?? '';
  if (r.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

try {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check(tools.join(',') === 'execute,search', `tools: ${tools.join(', ')}`);

  const ops = await tool('search', { code: 'async () => Object.keys((await api.spec()).paths).length', reason: 'smoke test: count operations' });
  check(ops > 60, `search: ${ops} operations in the catalogue`);

  const who = await tool('execute', {
    code: `async () => {
      const me = await api.call('whoami', {});
      const rules = await api.call('company_rules_get', {});
      const wiki = await api.call('wiki_list', {});
      const low = await api.call('low_stock_report', {});
      return { company: me.company_name, scopes: me.scopes, rules_revision: rules.revision,
               wiki: wiki.files.map(f => f.path), low: low.items.filter(i => i.status !== 'ok').length };
    }`,
    reason: 'smoke test: signed-in context',
  });
  check(Boolean(who.company), `execute: signed in to ${who.company} with ${who.scopes.join(', ')}; wiki ${who.wiki.join(' ')}; ${who.low} items below reorder`);

  const guides = await tool('execute', {
    code: `async () => { const l = await api.call('guide_list', {}); const g = await api.call('guide_get', { module: 'buying' });
      return { modules: l.guides.map(x => x.module), buying: g.title }; }`,
    reason: 'smoke test: guides',
  });
  check(guides.modules.length >= 11 && Boolean(guides.buying), `guides: ${guides.modules.length} modules served (${guides.modules.join(', ')})`);

  if (who.scopes.includes('approve')) {
    const users = await tool('execute', {
      code: `async () => (await api.call('users_list', {})).users.map(u => ({ email: u.email, live: u.active_sessions.length }))`,
      reason: 'smoke test: who is signed in',
    });
    check(users.some((u: { live: number }) => u.live > 0), `users_list: ${users.length} members, ${users.filter((u: { live: number }) => u.live > 0).length} signed in now`);
  }

  const where = 'C:\\smoke-test\\smoke-test-document.pdf';
  const add = {
    kind: 'other', title: 'smoke test', location: where, text: 'Smoke test document (fictional)',
    request_key: `smoke-${randomUUID()}`, reason: 'smoke test: keep a document by location',
  };
  const doc = await tool('execute', {
    code: `async () => {
      const d = await api.call('document_add', ${JSON.stringify(add)});
      const got = await api.call('document_get', { document_id: d.document_id });
      return { id: d.document_id, duplicate: d.duplicate, location: got.location, saved_by: got.saved_by.email };
    }`,
    reason: 'smoke test: document by location',
  });
  check(doc.location === where, `document: ${doc.id} at ${doc.location} (saved by ${doc.saved_by}${doc.duplicate ? ', found again' : ''})`);

  const audit = await tool('execute', {
    code: `async () => (await api.call('audit_list', { limit: 10 })).items.map(i => i.reason)`,
    reason: 'smoke test: audit trail',
  });
  check(audit.includes('smoke test: document by location'), 'audit log has the reasons of this run');
} catch (e) {
  check(false, e instanceof Error ? e.message : String(e));
} finally {
  await bridge.close();
}
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll smoke checks passed.');
process.exitCode = failures ? 1 : 0;
