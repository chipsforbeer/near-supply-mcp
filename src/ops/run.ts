import { createHash } from 'node:crypto';
import { z } from 'zod';
import { withCompany } from '../db/pool.ts';
import { validReason } from '../audit/audit.ts';
import { OpError } from './errors.ts';
import { getOp } from './catalogue.ts';
import type { OpContext, OpDef } from './types.ts';

export type RunOptions = { autoStripForReads?: boolean; allowHidden?: boolean };

export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// JSON round trip: Dates become ISO strings, undefined disappears, results are plain data.
function plain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function invalid(e: z.ZodError): OpError {
  return new OpError(
    'invalid_arguments',
    'Invalid arguments.',
    e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}

// Database errors that a caller can act on get a constant, safe message.
export function mapDbError(e: unknown): unknown {
  if (e instanceof OpError) return e;
  const code = (e as { code?: unknown })?.code;
  switch (code) {
    case '23505': return new OpError('conflict', 'A record with these values already exists.');
    case '23503': return new OpError('invalid_arguments', 'A referenced record does not exist.');
    case '23514': return new OpError('invalid_arguments', 'A value is outside the allowed range.');
    case '23502': return new OpError('invalid_arguments', 'A required value is missing.');
    case '22P02': return new OpError('invalid_arguments', 'A value has the wrong format.');
    case '22003': return new OpError('invalid_arguments', 'A number is too large.');
    case '57014': return new OpError('limit_exceeded', 'The query took too long and was stopped.');
    default: return e;
  }
}

export async function runOperation(name: string, rawArgs: unknown, ctx: OpContext, opts: RunOptions = {}): Promise<unknown> {
  const def = getOp(name);
  if (!def || (def.hidden && !opts.allowHidden)) throw new OpError('unknown_operation', `Unknown operation: ${name}. Use search to list operations.`);
  if (!ctx.session.scopes.includes(def.scope)) {
    throw new OpError('forbidden', `This operation needs the ${def.scope} scope.`);
  }
  if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    throw new OpError('invalid_arguments', 'Arguments must be an object.');
  }
  const raw = { ...(rawArgs as Record<string, unknown>) };
  return def.kind === 'read' ? runRead(def, raw, ctx, opts) : runWrite(def, raw, ctx);
}

async function journalRead(ctx: OpContext, op: string, argsHash: string, status: 'completed' | 'failed', errorCode: string | null) {
  await withCompany(ctx.db.app, ctx.session.companyId, (tx) =>
    tx.query(
      `INSERT INTO operation_journal (user_id, session_id, tool_audit_id, operation, kind, args_hash, status, error_code, finished_at)
       VALUES ($1, $2, $3, $4, 'read', $5, $6, $7, now())`,
      [ctx.session.userId, ctx.session.sessionId, ctx.toolAuditId, op, argsHash, status, errorCode],
    ),
  );
}

async function runRead(def: OpDef<z.ZodObject, unknown>, raw: Record<string, unknown>, ctx: OpContext, opts: RunOptions) {
  if (opts.autoStripForReads) {
    const shape = def.input.shape as Record<string, unknown>;
    if (!('request_key' in shape)) delete raw.request_key;
    if (!('reason' in shape)) delete raw.reason;
  }
  const parsed = def.input.safeParse(raw);
  const argsHash = sha256(stableJson(parsed.success ? parsed.data : raw));
  if (!parsed.success) {
    await journalRead(ctx, def.name, argsHash, 'failed', 'invalid_arguments');
    throw invalid(parsed.error);
  }
  try {
    const result = await withCompany(ctx.db.app, ctx.session.companyId, (tx) => def.handler(parsed.data, tx, ctx), { readOnly: true });
    await journalRead(ctx, def.name, argsHash, 'completed', null);
    return plain(result);
  } catch (e) {
    const mapped = mapDbError(e);
    await journalRead(ctx, def.name, argsHash, 'failed', mapped instanceof OpError ? mapped.code : 'internal');
    throw mapped;
  }
}

async function runWrite(def: OpDef<z.ZodObject, unknown>, raw: Record<string, unknown>, ctx: OpContext) {
  const schema = def.input.safeExtend({ request_key: z.string().min(8).max(128), reason: z.string() });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const { request_key: requestKey, reason: rawReason, ...args } = parsed.data as Record<string, unknown> & {
    request_key: string;
    reason: string;
  };
  const reason = validReason(rawReason);
  const argsHash = sha256(stableJson({ operation: def.name, args }));
  const s = ctx.session;
  try {
    return await withCompany(ctx.db.app, s.companyId, async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO operation_journal (user_id, session_id, tool_audit_id, operation, kind, reason, request_key, args_hash, status)
         VALUES ($1, $2, $3, $4, 'write', $5, $6, $7, 'started')
         ON CONFLICT (company_id, request_key) DO NOTHING
         RETURNING id`,
        [s.userId, s.sessionId, ctx.toolAuditId, def.name, reason, requestKey, argsHash],
      );
      let journalId: string;
      if (inserted.rowCount === 0) {
        const existing = (
          await tx.query(
            'SELECT id, args_hash, status, result FROM operation_journal WHERE request_key = $1 FOR UPDATE',
            [requestKey],
          )
        ).rows[0];
        if (!existing) throw new OpError('conflict', 'The request_key is busy; retry shortly.');
        if (existing.args_hash !== argsHash) {
          throw new OpError('request_key_reused', 'This request_key was already used for a different call; use a new key.');
        }
        if (existing.status === 'completed') return existing.result as unknown;
        await tx.query(`UPDATE operation_journal SET status = 'started', error_code = NULL, finished_at = NULL WHERE id = $1`, [existing.id]);
        journalId = existing.id;
      } else {
        journalId = inserted.rows[0].id;
      }
      // The change log ties every row this write changes to this journal entry (who, what, why).
      await tx.query(`SELECT set_config('app.journal_id', $1, true)`, [String(journalId)]);
      const result = plain(await def.handler(args, tx, { ...ctx, reason }));
      await tx.query(
        `UPDATE operation_journal SET status = 'completed', result = $2, finished_at = now() WHERE id = $1`,
        [journalId, JSON.stringify(result)],
      );
      return result;
    });
  } catch (e) {
    const mapped = mapDbError(e);
    if (!(mapped instanceof OpError && mapped.code === 'request_key_reused')) {
      const code = mapped instanceof OpError ? mapped.code : 'internal';
      await withCompany(ctx.db.app, s.companyId, (tx) =>
        tx.query(
          `INSERT INTO operation_journal (user_id, session_id, tool_audit_id, operation, kind, reason, request_key, args_hash, status, error_code, finished_at)
           VALUES ($1, $2, $3, $4, 'write', $5, $6, $7, 'failed', $8, now())
           ON CONFLICT (company_id, request_key) DO UPDATE
             SET status = 'failed', error_code = EXCLUDED.error_code, finished_at = now()
             WHERE operation_journal.status <> 'completed'`,
          [s.userId, s.sessionId, ctx.toolAuditId, def.name, reason, requestKey, argsHash, code],
        ),
      ).catch(() => undefined);
    }
    throw mapped;
  }
}
