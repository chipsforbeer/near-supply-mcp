import { z } from 'zod';
import { defineOp } from '../define.ts';
import { appendText, changePage, checkRevision, MAX_PAGE_CHARS, requireLivePage, wikiActor } from './pages.ts';
import { wikiPath } from './paths.ts';

export default defineOp({
  name: 'wiki_append',
  summary:
    'Add text to the end of a wiki .md file (timeline entries, run notes). A newline is put between the old end and the new ' +
    'text when the page does not already end with one. expected_revision is optional here.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      path: wikiPath,
      text: z.string().min(1).max(MAX_PAGE_CHARS),
      expected_revision: z.number().int().min(1).optional(),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const page = await requireLivePage(tx, args.path);
    checkRevision(page, args.expected_revision);
    return changePage(tx, page, { body_md: appendText(page.body_md, args.text) }, 'edit', wikiActor(ctx));
  },
});
