import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BridgeOAuthProvider, Session } from './remote.ts';
import { DEFAULT_RETRY_DELAYS_MS, isTransient, retrying, retryingFetch, stderrLog, type Log } from './retry.ts';
import type { TokenStore } from './token-store.ts';

// A server run may take its full 60 seconds; leave room for the network on top.
const CALL_TIMEOUT_MS = 120_000;

const reason = z.string().describe('Why you are doing this (1 to 500 characters). Stored in the audit log; no secrets.');

export type BridgeOptions = {
  server: string;
  store: TokenStore;
  openBrowser: (url: URL) => Promise<void>;
  callbackTimeoutMs?: number;
  // The network underneath, the waits between retries and where retries are logged (stderr).
  fetch?: typeof fetch;
  retryDelaysMs?: readonly number[];
  log?: Log;
};

export type Bridge = { server: McpServer; close(): Promise<void> };

function text(t: string, isError = false) {
  return isError ? { isError: true, content: [{ type: 'text' as const, text: t }] } : { content: [{ type: 'text' as const, text: t }] };
}

// A local stdio MCP server that passes search/execute through to the hosted server, retrying
// dropped connections. Optional: the hosted server's /mcp endpoint can be added directly.
export async function createBridge(opts: BridgeOptions): Promise<Bridge> {
  const origin = new URL(opts.server).origin;
  const mcpUrl = new URL('/mcp', origin);
  const net = { fetch: opts.fetch ?? fetch, delaysMs: opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS, log: opts.log ?? stderrLog };
  // Sign-in and the MCP connection re-send only requests that never left this machine.
  const notSentRetry = retryingFetch(net.fetch, net.delaysMs, net.log);
  const provider = new BridgeOAuthProvider(opts.store, opts.openBrowser);
  const session = new Session(provider, opts.store, mcpUrl, opts.callbackTimeoutMs, notSentRetry);

  let client: Client | null = null;
  async function remote(): Promise<Client> {
    await session.ensure();
    if (client) return client;
    const c = new Client({ name: 'supplier-inventory-bridge', version: '0.1.0' });
    await c.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider, fetch: notSentRetry }));
    client = c;
    return c;
  }

  const server = new McpServer(
    { name: 'supplier-inventory', version: '0.1.0' },
    {
      instructions:
        'Local bridge to the supplier-inventory server. search and execute run on the server (see its rules via company_rules_get). ' +
        'The server stores no files: keep a file as a document with document_add (its full path here, or a link) and the text you read from it.',
    },
  );

  for (const tool of ['search', 'execute'] as const) {
    server.registerTool(
      tool,
      {
        description:
          tool === 'search'
            ? 'Search the operation catalogue: code is a JavaScript async arrow function using api.spec(). Returns operations and their argument schemas.'
            : 'Run operations: code is a JavaScript async arrow function using api.call(name, args). Writes need args.request_key and args.reason.',
        inputSchema: { code: z.string(), reason },
      },
      async ({ code, reason: why }) => {
        try {
          const run = async () => {
            const c = await remote();
            return c.callTool({ name: tool, arguments: { code, reason: why } }, CallToolResultSchema, { timeout: CALL_TIMEOUT_MS });
          };
          // search only reads, so any dropped connection is retried; execute may write, so it
          // relies on the never-sent retry underneath only.
          const r = tool === 'search' ? await retrying('search', run, isTransient, net.delaysMs, net.log) : await run();
          return r as { content: { type: 'text'; text: string }[]; isError?: boolean };
        } catch (e) {
          return text(`Error: ${e instanceof Error ? e.message : String(e)}`, true);
        }
      },
    );
  }

  return {
    server,
    async close() {
      await client?.close();
      await server.close();
    },
  };
}
