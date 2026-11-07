import { z } from 'zod';
import { defineOp } from '../define.ts';

export default defineOp({
  name: 'audit_list',
  summary: 'Recent tool calls with their reasons and the operations each one ran (who changed what, and why).',
  kind: 'read',
  scope: 'read',
  input: z
    .object({
      limit: z.number().int().min(1).max(200).default(50),
      since: z.iso.datetime({ offset: true }).optional(),
      tool: z.string().max(80).optional(),
    })
    .strict(),
  async handler(args, tx) {
    const { rows } = await tx.query(
      `SELECT t.id AS tool_audit_id, t.started_at AS at, u.email AS user_email, t.client, t.tool, t.reason,
              o.outcome, o.finished_at,
              coalesce((SELECT json_agg(json_build_object('operation', j.operation, 'kind', j.kind,
                                                         'reason', j.reason, 'status', j.status) ORDER BY j.id)
                          FROM operation_journal j WHERE j.tool_audit_id = t.id), '[]'::json) AS operations
         FROM tool_audit t
         JOIN app_user u ON u.id = t.user_id
         LEFT JOIN tool_audit_outcome o ON o.tool_audit_id = t.id
        WHERE ($1::timestamptz IS NULL OR t.started_at >= $1)
          AND ($2::text IS NULL OR t.tool = $2)
        ORDER BY t.started_at DESC
        LIMIT $3`,
      [args.since ?? null, args.tool ?? null, args.limit],
    );
    return { items: rows };
  },
});
