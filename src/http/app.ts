import express from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { KeySignInProvider } from '../auth/provider.ts';
import { signInRouter } from '../auth/signin-page.ts';
import { createMcpServer } from '../mcp/server.ts';
import { opsRouter, sendError } from './ops-routes.ts';
import { sessionFromRequest } from './session.ts';

export type AppDeps = { cfg: Config; db: Db; signInLimitPerMinute?: number };

export function createApp(deps: AppDeps): express.Express {
  const { cfg, db } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy ? 'loopback' : false);

  const provider = new KeySignInProvider(db, cfg);
  const mcpUrl = new URL('/mcp', cfg.publicOrigin);
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(cfg.publicOrigin),
      resourceServerUrl: mcpUrl,
      scopesSupported: ['read', 'write', 'approve'],
      resourceName: 'Supplier inventory MCP',
    }),
  );
  app.use(signInRouter(db, cfg, provider, deps.signInLimitPerMinute ?? 10));

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });

  // Stateless Streamable HTTP: a fresh server and transport per request, plain JSON responses.
  app.post('/mcp', bearer, express.json({ limit: '512kb' }), async (req, res) => {
    try {
      const session = sessionFromRequest(req);
      const server = createMcpServer({ db, cfg, session });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) sendError(res, e);
    }
  });
  app.all('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed' });
  });

  app.use('/api/v1/ops', opsRouter(deps, bearer));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}
