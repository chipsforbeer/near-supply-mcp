import { z } from 'zod';
import { defineOp } from '../define.ts';

// Identity tables are shared by all companies (a person may belong to several), so every
// query here filters on the signed-in company explicitly.
export default defineOp({
  name: 'users_list',
  summary:
    "Who has access to this company: each member's email, name, scopes and status, their API keys (label, created, " +
    'last used, revoked; never the key itself), and who is signed in now (each live session: client, since, last used, ends).',
  kind: 'read',
  scope: 'approve',
  input: z.object({}).strict(),
  async handler(_args, tx, ctx) {
    const company = ctx.session.companyId;
    const members = await tx.query(
      `SELECT u.id AS user_id, u.email, u.display_name, m.scopes,
              CASE WHEN u.disabled_at IS NOT NULL THEN 'user_disabled'
                   WHEN m.disabled_at IS NOT NULL THEN 'membership_disabled' ELSE 'active' END AS status,
              (SELECT max(e.at) FROM auth_event e
                WHERE e.user_id = u.id AND e.company_id = $1 AND e.kind = 'signin_ok') AS last_signed_in_at
         FROM membership m JOIN app_user u ON u.id = m.user_id
        WHERE m.company_id = $1
        ORDER BY u.email`,
      [company],
    );
    const ids = members.rows.map((m) => m.user_id);
    const keys = await tx.query(
      `SELECT id AS key_id, user_id, label, created_at, last_used_at, revoked_at
         FROM api_key WHERE user_id = ANY($1) ORDER BY created_at`,
      [ids],
    );
    const sessions = await tx.query(
      `SELECT s.id AS session_id, s.user_id, oc.client_name, k.label AS key_label,
              s.created_at AS signed_in_at, s.last_used_at, s.expires_at
         FROM oauth_session s
         JOIN oauth_client oc ON oc.client_id = s.client_id
         LEFT JOIN api_key k ON k.id = s.api_key_id
        WHERE s.company_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        ORDER BY s.last_used_at DESC NULLS LAST, s.created_at DESC`,
      [company],
    );
    const strip = <T extends { user_id: string }>({ user_id: _u, ...rest }: T) => rest;
    return {
      users: members.rows.map((m) => ({
        ...m,
        keys: keys.rows.filter((k) => k.user_id === m.user_id).map(strip),
        active_sessions: sessions.rows.filter((s) => s.user_id === m.user_id).map(strip),
      })),
    };
  },
});
