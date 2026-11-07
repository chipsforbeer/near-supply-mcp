import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { deletedPage, livePage } from './pages.ts';
import { wikiPath } from './paths.ts';

export default defineOp({
  name: 'wiki_history',
  summary:
    'Every change to one wiki file, newest first: revision, what happened (create, edit, move, delete, restore), its path then, ' +
    'size, who and why. Works for deleted pages too. Read an old version with wiki_read and revision.',
  kind: 'read',
  scope: 'read',
  input: z
    .object({
      path: wikiPath,
      limit: z.number().int().min(1).max(200).default(20),
    })
    .strict(),
  async handler(args, tx) {
    const page = (await livePage(tx, args.path)) ?? (await deletedPage(tx, args.path));
    if (!page) throw new OpError('not_found', `No page ${args.path}, live or deleted.`);
    const r = await tx.query(
      `SELECT r.revision, r.action, r.path, r.title, octet_length(r.body_md) AS bytes, r.reason,
              u.email AS author_email, r.via_agent, r.created_at
         FROM wiki_revision r LEFT JOIN app_user u ON u.id = r.author_user_id
        WHERE r.page_id = $1
        ORDER BY r.revision DESC
        LIMIT $2`,
      [page.id, args.limit],
    );
    return { path: page.path, status: page.status, latest_revision: page.revision, revisions: r.rows };
  },
});
