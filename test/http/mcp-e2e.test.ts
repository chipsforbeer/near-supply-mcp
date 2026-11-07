import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resetTestDatabase } from '../helpers/db.ts';
import { startTestServer, provisionUser, signInHeadless, callOp, type TestServer } from '../helpers/http.ts';

let server: TestServer;
before(async () => {
  await resetTestDatabase();
  server = await startTestServer();
});
after(() => server.close());

test('an MCP client with a bearer token runs execute against its company', async () => {
  const p = await provisionUser();
  const s = await signInHeadless(server.url, p.key);
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${s.accessToken}` } },
  });
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['execute', 'search']);
  const r = await client.callTool({
    name: 'execute',
    arguments: { code: `async () => (await api.call('whoami', {})).company_id`, reason: 'end-to-end check' },
  });
  assert.equal(JSON.parse((r.content as { text: string }[])[0]!.text), p.companies[0]!.id);
  await client.close();
});

test('the MCP endpoint refuses requests without a token', async () => {
  const r = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate') ?? '', /resource_metadata/);
});

test('the ops endpoint requires a reason', async () => {
  const p = await provisionUser();
  const s = await signInHeadless(server.url, p.key);
  const r = await callOp(server.url, s.accessToken!, 'whoami', {});
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_arguments');
  const unknown = await callOp(server.url, s.accessToken!, 'nope', {}, 'try');
  assert.equal(unknown.status, 404);
});
