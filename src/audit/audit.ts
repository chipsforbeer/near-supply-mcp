import { randomUUID } from 'node:crypto';
import { withCompany, type Db } from '../db/pool.ts';
import { OpError } from '../ops/errors.ts';
import type { Session } from '../ops/types.ts';

// Every tool call and every write carries a reason written by the AI.
export function validReason(value: unknown): string {
  if (typeof value !== 'string') throw new OpError('invalid_arguments', 'reason is required.');
  const reason = value.trim();
  if (reason.length < 1 || reason.length > 500) {
    throw new OpError('invalid_arguments', 'reason must be 1 to 500 characters.');
  }
  return reason;
}

export async function startToolAudit(
  db: Db,
  session: Session,
  tool: string,
  reason: string,
  codeSha256: string | null,
): Promise<string> {
  const id = randomUUID();
  const checked = validReason(reason);
  await withCompany(db.app, session.companyId, (tx) =>
    tx.query(
      `INSERT INTO tool_audit (id, user_id, session_id, client, tool, reason, code_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, session.userId, session.sessionId, session.client, tool, checked, codeSha256],
    ),
  );
  return id;
}

export async function finishToolAudit(
  db: Db,
  session: Session,
  id: string,
  outcome: 'ok' | 'error',
  operationsCalled: number,
  errorKind: string | null,
): Promise<void> {
  await withCompany(db.app, session.companyId, (tx) =>
    tx.query(
      `INSERT INTO tool_audit_outcome (tool_audit_id, outcome, operations_called, error_kind)
       VALUES ($1, $2, $3, $4)`,
      [id, outcome, operationsCalled, errorKind],
    ),
  );
}
