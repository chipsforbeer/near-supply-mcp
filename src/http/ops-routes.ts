import express, { type RequestHandler, type Response } from 'express';
import { finishToolAudit, startToolAudit } from '../audit/audit.ts';
import { publicError, type OpErrorCode } from '../ops/errors.ts';
import { runOperation } from '../ops/run.ts';
import type { OpContext } from '../ops/types.ts';
import { sessionFromRequest } from './session.ts';
import type { AppDeps } from './app.ts';

const STATUS: Record<OpErrorCode, number> = {
  unknown_operation: 404,
  forbidden: 403,
  invalid_arguments: 400,
  not_found: 404,
  conflict: 409,
  request_key_reused: 409,
  revision_mismatch: 409,
  unavailable: 503,
  limit_exceeded: 429,
  internal: 500,
};

export function sendError(res: Response, e: unknown): void {
  const p = publicError(e);
  res.status(STATUS[p.code]).json({ ok: false, error: p });
}

// POST /api/v1/ops/:name  body { reason, args } -> { ok, result } | { ok: false, error }
export function opsRouter(deps: AppDeps, bearer: RequestHandler): express.Router {
  const router = express.Router();
  router.post('/:name', bearer, express.json({ limit: '512kb' }), async (req, res) => {
    let auditId: string | null = null;
    let session;
    try {
      session = sessionFromRequest(req, 'http');
      const body = (req.body ?? {}) as { reason?: unknown; args?: unknown };
      const name = String(req.params.name);
      auditId = await startToolAudit(deps.db, session, `op:${name}`.slice(0, 80), body.reason as string, null);
      const ctx: OpContext = { db: deps.db, cfg: deps.cfg, session, toolAuditId: auditId };
      const result = await runOperation(name, body.args ?? {}, ctx);
      await finishToolAudit(deps.db, session, auditId, 'ok', 1, null);
      res.json({ ok: true, result });
    } catch (e) {
      if (auditId && session) {
        await finishToolAudit(deps.db, session, auditId, 'error', 1, publicError(e).code).catch(() => undefined);
      }
      sendError(res, e);
    }
  });
  return router;
}
