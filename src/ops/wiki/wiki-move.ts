import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { changePage, checkRevision, linkedFrom, requireLivePage, wikiActor } from './pages.ts';
import { wikiPath } from './paths.ts';

export default defineOp({
  name: 'wiki_move',
  summary:
    'Rename or move a wiki .md file to a new path, keeping its history. Refused if the new path exists. Returns linked_from: ' +
    'pages that still link to the old path; fix those links with wiki_replace.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      path: wikiPath,
      new_path: wikiPath,
      expected_revision: z.number().int().min(1).optional(),
    })
    .strict(),
  async handler(args, tx, ctx) {
    if (args.new_path === args.path) throw new OpError('invalid_arguments', 'new_path is the same as path.');
    const page = await requireLivePage(tx, args.path);
    checkRevision(page, args.expected_revision);
    const moved = await changePage(tx, page, { path: args.new_path }, 'move', wikiActor(ctx));
    return { ...moved, previous_path: args.path, linked_from: await linkedFrom(tx, args.path) };
  },
});
