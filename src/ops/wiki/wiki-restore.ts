import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { changePage, checkRevision, deletedPage, livePage, wikiActor } from './pages.ts';
import { wikiPath } from './paths.ts';

export default defineOp({
  name: 'wiki_restore',
  summary:
    'Bring back the past. For a deleted file: restores the most recently deleted page at that path (optionally as of an ' +
    'older revision). For a live file: pass revision and expected_revision to put an older revision\'s text back. ' +
    'Either way it is a new revision; nothing is overwritten.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      path: wikiPath,
      revision: z.number().int().min(1).optional(),
      expected_revision: z.number().int().min(1).optional(),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const live = await livePage(tx, args.path, true);
    if (live && args.revision === undefined) {
      throw new OpError('conflict', `${args.path} is a live page; to put an older revision back pass revision and expected_revision.`);
    }
    if (live && args.expected_revision === undefined) {
      throw new OpError('invalid_arguments', 'Restoring an older revision of a live page needs expected_revision (the revision you read).');
    }
    const page = live ?? (await deletedPage(tx, args.path, true));
    if (!page) throw new OpError('not_found', `No page ${args.path}, live or deleted.`);
    checkRevision(page, args.expected_revision);
    let body = page.body_md;
    if (args.revision !== undefined) {
      const r = await tx.query('SELECT body_md FROM wiki_revision WHERE page_id = $1 AND revision = $2', [page.id, args.revision]);
      if (!r.rows[0]) throw new OpError('not_found', `${args.path} has revisions 1 to ${page.revision}; see wiki_history.`);
      body = r.rows[0].body_md;
    }
    return changePage(tx, page, { body_md: body, status: 'active' }, 'restore', wikiActor(ctx));
  },
});
