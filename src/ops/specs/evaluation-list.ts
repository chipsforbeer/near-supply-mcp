import { z } from 'zod';
import { defineOp } from '../define.ts';
import { SUBJECT_TYPES } from './evaluation-log.ts';
import { limit } from '../schemas.ts';

export default defineOp({
  name: 'evaluation_list',
  summary: 'Logged verdicts, newest first, optionally for one subject or one verdict, with the spec version judged against and who decided.',
  kind: 'read',
  scope: 'read',
  input: z
    .object({
      subject_type: z.enum(SUBJECT_TYPES).optional(),
      subject_id: z.uuid().optional(),
      verdict: z.enum(['good', 'not_good', 'needs_info']).optional(),
      limit: limit(200, 50),
    })
    .strict(),
  async handler(args, tx) {
    const r = await tx.query(
      `SELECT e.id AS evaluation_id, e.subject_type, e.subject_id, e.verdict, e.reasoning, e.evidence_document_ids,
              s.version AS spec_version, u.email AS decided_by, e.via_agent, e.decided_at, e.supersedes_id
         FROM evaluation e LEFT JOIN item_spec s ON s.id = e.spec_id JOIN app_user u ON u.id = e.decided_by
        WHERE ($1::text IS NULL OR e.subject_type = $1) AND ($2::uuid IS NULL OR e.subject_id = $2)
          AND ($3::text IS NULL OR e.verdict = $3)
        ORDER BY e.decided_at DESC LIMIT $4`,
      [args.subject_type ?? null, args.subject_id ?? null, args.verdict ?? null, args.limit],
    );
    return { items: r.rows };
  },
});
