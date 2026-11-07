import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';

export default defineOp({
  name: 'operation_status',
  summary: 'Look up a write by its request_key: did it complete, fail, or never arrive? Use before retrying after a timeout.',
  kind: 'read',
  scope: 'read',
  input: z.object({ request_key: z.string().min(8).max(128) }).strict(),
  async handler(args, tx) {
    const { rows } = await tx.query(
      `SELECT request_key, operation, status, error_code, finished_at, result
         FROM operation_journal WHERE request_key = $1`,
      [args.request_key],
    );
    const row = rows[0];
    if (!row) throw new OpError('not_found', 'No write with that request_key.');
    return {
      request_key: row.request_key,
      operation: row.operation,
      status: row.status,
      error_code: row.error_code,
      finished_at: row.finished_at,
      result: row.status === 'completed' ? row.result : null,
    };
  },
});
