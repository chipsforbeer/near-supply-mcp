import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';

export default defineOp({
  name: 'company_rules_get',
  summary:
    "Read the company's rules page (wiki rules.md) and its last change (when, by whom, why). Call this first and follow it. " +
    'Only someone with the approve permission can change the rules.',
  kind: 'read',
  scope: 'read',
  input: z.object({}).strict(),
  async handler(_args, tx) {
    const r = await tx.query(
      `SELECT p.body_md, p.revision, p.updated_at, r.created_at AS changed_at, r.action, r.reason, u.email AS changed_by
         FROM wiki_page p
         LEFT JOIN wiki_revision r ON r.page_id = p.id AND r.revision = p.revision
         LEFT JOIN app_user u ON u.id = r.author_user_id
        WHERE p.path = 'rules.md' AND p.status = 'active'`,
    );
    const row = r.rows[0];
    if (!row) throw new OpError('not_found', 'This company has no rules.md page yet.');
    return {
      body_md: row.body_md,
      revision: row.revision,
      updated_at: row.updated_at,
      last_change: { at: row.changed_at, by: row.changed_by, action: row.action, reason: row.reason },
    };
  },
});
