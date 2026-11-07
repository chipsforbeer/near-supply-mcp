import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { parseWikiLinks } from './links.ts';
import { linkedFrom, requireLivePage } from './pages.ts';
import { wikiPath } from './paths.ts';

export default defineOp({
  name: 'wiki_read',
  summary:
    'Read one wiki .md file: its text (or a line range of it, for long pages), its revision (needed to rewrite or delete it), ' +
    'the pages and rows it links to, and the pages that link to it. Pass revision to read an older version.',
  kind: 'read',
  scope: 'read',
  input: z
    .object({
      path: wikiPath,
      revision: z.number().int().min(1).optional(),
      from_line: z.number().int().min(1).optional(),
      to_line: z.number().int().min(1).optional(),
    })
    .strict(),
  async handler(args, tx) {
    const page = await requireLivePage(tx, args.path, false);
    let body = page.body_md;
    let title = page.title;
    let revision = page.revision;
    if (args.revision !== undefined && args.revision !== page.revision) {
      const r = await tx.query('SELECT title, body_md FROM wiki_revision WHERE page_id = $1 AND revision = $2', [page.id, args.revision]);
      if (!r.rows[0]) throw new OpError('not_found', `${page.path} has revisions 1 to ${page.revision}; see wiki_history.`);
      ({ title, body_md: body } = r.rows[0]);
      revision = args.revision;
    }
    const lines = body.split('\n');
    const from = args.from_line ?? 1;
    const to = Math.min(args.to_line ?? lines.length, lines.length);
    if (from > lines.length) throw new OpError('invalid_arguments', `from_line is past the end; the page has ${lines.length} lines.`);
    if (to < from) throw new OpError('invalid_arguments', 'to_line must not be before from_line.');

    const parsed = parseWikiLinks(body, page.path);
    const existing = await tx.query(`SELECT path FROM wiki_page WHERE status = 'active' AND path = ANY($1)`, [parsed.pages]);
    const live = new Set(existing.rows.map((x) => x.path));
    return {
      page_id: page.id,
      path: page.path,
      title,
      revision,
      latest_revision: page.revision,
      updated_at: page.updated_at,
      entity_type: page.entity_type,
      entity_id: page.entity_id,
      total_lines: lines.length,
      from_line: from,
      to_line: to,
      body_md: lines.slice(from - 1, to).join('\n'),
      links: {
        pages: [...parsed.pages].sort().map((path) => ({ path, exists: live.has(path) })),
        entities: parsed.entities,
      },
      linked_from: (await linkedFrom(tx, page.path)).filter((p) => p !== page.path),
    };
  },
});
