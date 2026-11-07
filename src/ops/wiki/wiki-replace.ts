import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { changePage, checkRevision, MAX_PAGE_CHARS, requireLivePage, wikiActor } from './pages.ts';
import { wikiPath } from './paths.ts';

export default defineOp({
  name: 'wiki_replace',
  summary:
    'Replace exact text in a wiki .md file. Refused unless old_text occurs exactly expected_replacements times (default 1); ' +
    'the error says how many were found. new_text may be empty to remove text. expected_revision is optional here.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      path: wikiPath,
      old_text: z.string().min(1).max(MAX_PAGE_CHARS),
      new_text: z.string().max(MAX_PAGE_CHARS),
      expected_replacements: z.number().int().min(1).max(1000).default(1),
      expected_revision: z.number().int().min(1).optional(),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const page = await requireLivePage(tx, args.path);
    checkRevision(page, args.expected_revision);
    const pieces = page.body_md.split(args.old_text);
    const found = pieces.length - 1;
    if (found !== args.expected_replacements) {
      throw new OpError(
        'conflict',
        `old_text occurs ${found} times in ${page.path}, not ${args.expected_replacements}; read the page and adjust old_text or expected_replacements.`,
        { found, expected_replacements: args.expected_replacements },
      );
    }
    const updated = await changePage(tx, page, { body_md: pieces.join(args.new_text) }, 'edit', wikiActor(ctx));
    return { ...updated, replacements: found };
  },
});
