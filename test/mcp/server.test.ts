import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resetTestDatabase, testDb, testConfig } from '../helpers/db.ts';
import { newActor } from '../helpers/ops.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { withCompany } from '../../src/db/pool.ts';

before(resetTestDatabase);

async function connect() {
  const actor = await newActor();
  const session = { ...actor.session, client: 'direct' as const };
  const server = createMcpServer({ db: testDb(), cfg: testConfig(), session });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  return { client, session };
}

function text(r: any): string {
  return r.content[0].text as string;
}

async function auditCount(companyId: string): Promise<{ starts: number; outcomes: number }> {
  return withCompany(testDb().app, companyId, async (tx) => {
    const a = await tx.query(`SELECT count(*)::int AS n FROM tool_audit WHERE tool IN ('search','execute')`);
    const b = await tx.query('SELECT count(*)::int AS n FROM tool_audit_outcome');
    return { starts: a.rows[0].n, outcomes: b.rows[0].n };
  });
}

test('exactly two tools: search and execute', async () => {
  const { client } = await connect();
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['execute', 'search']);
});

test('a missing reason is refused and nothing is audited', async () => {
  const { client, session } = await connect();
  const r = await client.callTool({ name: 'execute', arguments: { code: 'async () => 1', reason: '  ' } });
  assert.equal(r.isError, true);
  assert.deepEqual(await auditCount(session.companyId), { starts: 0, outcomes: 0 });
});

test('execute runs operations and writes one audit row with an outcome', async () => {
  const { client, session } = await connect();
  const r = await client.callTool({
    name: 'execute',
    arguments: { code: `async () => (await api.call('whoami', {})).company_id`, reason: 'check which company I am in' },
  });
  assert.notEqual(r.isError, true, text(r));
  assert.equal(JSON.parse(text(r)), session.companyId);
  assert.deepEqual(await auditCount(session.companyId), { starts: 1, outcomes: 1 });
});

test('search sees the catalogue but cannot call operations', async () => {
  const { client } = await connect();
  const r = await client.callTool({
    name: 'search',
    arguments: { code: `async () => ({ hasWhoami: '/operations/whoami' in (await api.spec()).paths, canCall: typeof api.call })`, reason: 'look up operations' },
  });
  assert.deepEqual(JSON.parse(text(r)), { hasWhoami: true, canCall: 'undefined' });
});
