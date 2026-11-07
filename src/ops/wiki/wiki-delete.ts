import { z } from 'zod';
import { defineOp } from '../define.ts';
import { changePage, checkRevision, linkedFrom, requireLivePage, wikiActor } from './pages.ts';
import { wikiPath } from './paths.ts';

export default defineOp({
  name: 'wiki_delete',
  summary:
    'Delete a wiki .md file. Nothing is lost: the page and its history stay, wiki_restore brings it back, and the path is free ' +
    'for a new page. Pass the revision you read. Returns linked_from: pages that still link to it.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      path: wikiPath,
      expected_revision: z.number().int().min(1),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const page = await requireLivePage(tx, args.path);
    checkRevision(page, args.expected_revision);
    const deleted = await changePage(tx, page, { status: 'deleted' }, 'delete', wikiActor(ctx));
    return { ...deleted, linked_from: await linkedFrom(tx, args.path) };
  },
});
