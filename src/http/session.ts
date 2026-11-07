import type { Request } from 'express';
import type { SessionExtra } from '../auth/provider.ts';
import { OpError } from '../ops/errors.ts';
import type { Client, Scope, Session } from '../ops/types.ts';

// Builds the operation session from a verified bearer token; never from request data.
export function sessionFromRequest(req: Request, client?: Client): Session {
  const auth = req.auth;
  const extra = auth?.extra as SessionExtra | undefined;
  if (!auth || !extra?.userId || !extra.companyId || !extra.sessionId) {
    throw new OpError('forbidden', 'Not signed in.');
  }
  return {
    userId: extra.userId,
    companyId: extra.companyId,
    sessionId: extra.sessionId,
    scopes: auth.scopes.filter((s): s is Scope => s === 'read' || s === 'write' || s === 'approve'),
    client: client ?? extra.client,
  };
}
