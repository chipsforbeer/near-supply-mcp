import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { finishToolAudit, startToolAudit, validReason } from '../audit/audit.ts';
import { publicError } from '../ops/errors.ts';
import { buildOpenApi } from '../ops/openapi.ts';
import { runOperation } from '../ops/run.ts';
import type { OpContext, Session } from '../ops/types.ts';
import { DEFAULT_LIMITS, SANDBOX_GATE, runInSandbox, type HostApi, type SandboxResult } from './sandbox.ts';
import { EXECUTE_DESCRIPTION, INSTRUCTIONS, SEARCH_DESCRIPTION } from './instructions.ts';

export type McpDeps = { db: Db; cfg: Config; session: Session };

const INPUT = {
  code: z.string().describe('JavaScript async arrow function, for example: async () => { ... }'),
  reason: z.string().describe('Why you are making this call (1 to 500 characters). Stored in the audit log; no secrets.'),
};

function textResult(text: string, isError = false) {
  return isError ? { isError: true, content: [{ type: 'text' as const, text }] } : { content: [{ type: 'text' as const, text }] };
}

// One server per request (stateless HTTP); the session comes from the verified token.
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'supplier-inventory', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  for (const tool of ['search', 'execute'] as const) {
    server.registerTool(
      tool,
      { description: tool === 'search' ? SEARCH_DESCRIPTION : EXECUTE_DESCRIPTION, inputSchema: INPUT },
      async ({ code, reason }) => {
        let auditId: string;
        try {
          auditId = await startToolAudit(deps.db, deps.session, tool, validReason(reason), createHash('sha256').update(code).digest('hex'));
        } catch (e) {
          return textResult(`Error: ${publicError(e).message}`, true);
        }
        const ctx: OpContext = { db: deps.db, cfg: deps.cfg, session: deps.session, toolAuditId: auditId };
        const spec = async () => buildOpenApi(deps.session.scopes);
        const host: HostApi = tool === 'search' ? { spec } : { spec, call: (op, args) => runOperation(op, args, ctx) };
        let result: SandboxResult;
        try {
          result = await SANDBOX_GATE.run(() => runInSandbox(code, host, DEFAULT_LIMITS));
        } catch (e) {
          result = { ok: false, error: publicError(e).message, calls: 0 };
        }
        await finishToolAudit(deps.db, deps.session, auditId, result.ok ? 'ok' : 'error', result.calls, result.ok ? null : 'run_failed');
        return result.ok ? textResult(result.text) : textResult(`Error: ${result.error}`, true);
      },
    );
  }
  return server;
}
