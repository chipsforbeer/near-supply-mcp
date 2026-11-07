import { randomUUID } from 'node:crypto';
import { runOperation } from '../../src/ops/run.ts';
import { startToolAudit } from '../../src/audit/audit.ts';
import { testDb, testConfig, createCompanyWithUser } from './db.ts';
import type { OpContext, Scope, Session } from '../../src/ops/types.ts';

export type Actor = { session: Session; ctx(): Promise<OpContext> };

export async function newActor(opts: { scopes?: Scope[]; companyId?: string } = {}): Promise<Actor> {
  const db = testDb();
  const scopes = opts.scopes ?? ['read', 'write', 'approve'];
  const { companyId, userId } = await createCompanyWithUser(db, { companyId: opts.companyId, scopes });
  const session: Session = { userId, companyId, sessionId: randomUUID(), scopes, client: 'test' };
  return {
    session,
    async ctx() {
      const toolAuditId = await startToolAudit(db, session, 'test', 'automated test', null);
      return { db, cfg: testConfig(), session, toolAuditId };
    },
  };
}

// Adds request_key and reason so tests read like real calls; reads drop them again.
// Test results are loosely typed on purpose.
export async function call<T = any>(actor: Actor, op: string, args: Record<string, unknown> = {}): Promise<T> {
  const ctx = await actor.ctx();
  const withMeta = { request_key: `test-${randomUUID()}`, reason: 'automated test', ...args };
  return (await runOperation(op, withMeta, ctx, { autoStripForReads: true })) as T;
}
