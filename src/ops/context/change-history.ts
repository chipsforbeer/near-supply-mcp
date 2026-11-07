import { z } from 'zod';
import { defineOp } from '../define.ts';

export default defineOp({
  name: 'change_history',
  summary:
    'What changed in the records, newest first: for each insert, update or delete, the table and row, the values before and ' +
    'after (only the changed fields for an update), and the operation, person and reason behind it. Filter by table (for ' +
    'example supplier, contact, contact_method, item, purchase_order), by row_id, or by time.',
  kind: 'read',
  scope: 'read',
  input: z
    .object({
      table: z.string().regex(/^[a-z][a-z_]{1,62}$/).optional(),
      row_id: z.string().min(1).max(64).optional(),
      since: z.iso.datetime({ offset: true }).optional(),
      limit: z.number().int().min(1).max(500).default(50),
    })
    .strict(),
  async handler(args, tx) {
    const r = await tx.query(
      `SELECT c.id::text AS id, c.at, c.table_name AS table, c.row_id, c.action, c.before, c.after,
              j.operation, j.reason, u.email AS user_email
         FROM change_log c
         LEFT JOIN operation_journal j ON j.id = c.journal_id
         LEFT JOIN app_user u ON u.id = j.user_id
        WHERE ($1::text IS NULL OR c.table_name = $1)
          AND ($2::text IS NULL OR c.row_id = $2)
          AND ($3::timestamptz IS NULL OR c.at >= $3)
        ORDER BY c.id DESC
        LIMIT $4`,
      [args.table ?? null, args.row_id ?? null, args.since ?? null, args.limit],
    );
    return { items: r.rows };
  },
});
