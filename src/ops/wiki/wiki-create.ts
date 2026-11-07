import { z } from 'zod';
import { defineOp } from '../define.ts';
import { createPage, ENTITY_TYPES, MAX_PAGE_CHARS, wikiActor } from './pages.ts';
import { wikiPath } from './paths.ts';

export default defineOp({
  name: 'wiki_create',
  summary:
    'Create a new wiki .md file (refused if it exists). Folders are part of the path, e.g. suppliers/acme-metals.md. ' +
    'Start with a "# Title" line. Link pages with [[path]] or relative Markdown links, rows with [[supplier:<id>]]. ' +
    'Pass entity_type and entity_id to tie the page to one supplier, item or other record.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      path: wikiPath,
      body_md: z.string().max(MAX_PAGE_CHARS),
      entity_type: z.enum(ENTITY_TYPES).optional(),
      entity_id: z.uuid().optional(),
    })
    .strict()
    .refine((v) => (v.entity_type === undefined) === (v.entity_id === undefined), { message: 'entity_type and entity_id go together.' }),
  async handler(args, tx, ctx) {
    return createPage(tx, args, wikiActor(ctx));
  },
});
