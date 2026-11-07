import { z } from 'zod';
import { defineOp } from '../define.ts';
import { wikiFolder } from './paths.ts';

export default defineOp({
  name: 'wiki_search',
  summary: 'Full-text search of the wiki (title, path, text), optionally within one folder. Words, "quoted phrases" and -exclusions work.',
  kind: 'read',
  scope: 'read',
  input: z
    .object({
      query: z.string().trim().min(1).max(200),
      folder: wikiFolder.default(''),
      limit: z.number().int().min(1).max(50).default(10),
    })
    .strict(),
  async handler(args, tx) {
    const r = await tx.query(
      `SELECT path, title, revision, updated_at,
              left(regexp_replace(body_md, '\\s+', ' ', 'g'), 200) AS snippet,
              ts_rank(search, q) AS rank
         FROM wiki_page, websearch_to_tsquery('simple', $1) q
        WHERE search @@ q AND status = 'active' AND ($2 = '' OR left(path, length($2) + 1) = $2 || '/')
        ORDER BY rank DESC, updated_at DESC
        LIMIT $3`,
      [args.query, args.folder, args.limit],
    );
    return { items: r.rows };
  },
});
