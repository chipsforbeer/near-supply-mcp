import { z } from 'zod';
import { defineOp } from '../define.ts';

const KINDS = ['signin_ok', 'signin_no_membership', 'token_issued', 'refresh_rotated', 'refresh_reused', 'session_revoked', 'key_revoked'] as const;

// Sign-ins and session changes for this company, newest first. Key revocations carry no
// company (a key belongs to a person), so they are shown for this company's members.
// Failed sign-ins with an unknown key have no person or company and are not shown here.
export default defineOp({
  name: 'auth_events_list',
  summary:
    'Sign-in history for this company, newest first: sign-ins, tokens issued and refreshed, sessions ended, keys revoked, ' +
    'with who, which client, which key (label) and the address it came from.',
  kind: 'read',
  scope: 'approve',
  input: z
    .object({
      limit: z.number().int().min(1).max(500).default(100),
      since: z.iso.datetime({ offset: true }).optional(),
      kind: z.enum(KINDS).optional(),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const r = await tx.query(
      `SELECT e.at, e.kind, u.email AS user_email, oc.client_name, k.label AS key_label, e.session_id, e.ip
         FROM auth_event e
         LEFT JOIN app_user u ON u.id = e.user_id
         LEFT JOIN oauth_client oc ON oc.client_id = e.client_id
         LEFT JOIN api_key k ON k.id = e.api_key_id
        WHERE (e.company_id = $1
               OR (e.company_id IS NULL AND e.kind = 'key_revoked'
                   AND e.user_id IN (SELECT user_id FROM membership WHERE company_id = $1)))
          AND ($2::timestamptz IS NULL OR e.at >= $2)
          AND ($3::text IS NULL OR e.kind = $3)
        ORDER BY e.at DESC, e.id DESC
        LIMIT $4`,
      [ctx.session.companyId, args.since ?? null, args.kind ?? null, args.limit],
    );
    return { items: r.rows };
  },
});
