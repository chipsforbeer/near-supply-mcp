import { randomUUID } from 'node:crypto';
import type { Config } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { startToolAudit, finishToolAudit } from '../audit/audit.ts';
import { runOperation } from '../ops/run.ts';
import type { OpContext, Session } from '../ops/types.ts';

// Runs operations for one company as a seed user, exactly as a client would (journal, reasons).
export class SeedRunner {
  private readonly ctx: OpContext;
  private n = 0;

  private constructor(ctx: OpContext) {
    this.ctx = ctx;
  }

  static async start(deps: { db: Db; cfg: Config }, companyId: string, userId: string): Promise<SeedRunner> {
    const session: Session = { userId, companyId, sessionId: randomUUID(), scopes: ['read', 'write', 'approve'], client: 'system' };
    const toolAuditId = await startToolAudit(deps.db, session, 'seed', 'fictional demo data', null);
    return new SeedRunner({ db: deps.db, cfg: deps.cfg, session, toolAuditId });
  }

  // Seed results are loosely typed on purpose.
  async op<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
    this.n += 1;
    return (await runOperation(name, { request_key: `seed-${randomUUID()}`, reason: 'fictional demo data', ...args }, this.ctx, { autoStripForReads: true })) as T;
  }

  async finish(): Promise<void> {
    await finishToolAudit(this.ctx.db, this.ctx.session, this.ctx.toolAuditId, 'ok', this.n, null);
  }
}

export const daysAgo = (d: number, hour = 10): string => {
  const t = new Date(Date.now() - d * 86_400_000);
  t.setUTCHours(hour, 0, 0, 0);
  return t.toISOString();
};
