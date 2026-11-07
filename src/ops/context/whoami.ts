import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';

export default defineOp({
  name: 'whoami',
  summary: 'Who is signed in, for which company, with which scopes, and this sign-in session (when it started and ends, which key).',
  kind: 'read',
  scope: 'read',
  input: z.object({}).strict(),
  async handler(_args, tx, ctx) {
    const { rows } = await tx.query(
      `SELECT u.email, u.display_name, c.name AS company_name
         FROM app_user u, company c
        WHERE u.id = $1 AND c.id = $2`,
      [ctx.session.userId, ctx.session.companyId],
    );
    const row = rows[0];
    if (!row) throw new OpError('not_found', 'Session user or company not found.');
    const s = await tx.query(
      `SELECT s.created_at AS signed_in_at, s.expires_at, s.last_used_at, oc.client_name, k.label AS key_label
         FROM oauth_session s
         JOIN oauth_client oc ON oc.client_id = s.client_id
         LEFT JOIN api_key k ON k.id = s.api_key_id
        WHERE s.id = $1 AND s.user_id = $2 AND s.company_id = $3`,
      [ctx.session.sessionId, ctx.session.userId, ctx.session.companyId],
    );
    return {
      user_id: ctx.session.userId,
      email: row.email,
      display_name: row.display_name,
      company_id: ctx.session.companyId,
      company_name: row.company_name,
      scopes: ctx.session.scopes,
      session: s.rows[0] ? { id: ctx.session.sessionId, ...s.rows[0] } : null,
    };
  },
});
