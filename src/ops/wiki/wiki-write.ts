import { z } from 'zod';
import { defineOp } from '../define.ts';
import { changePage, checkRevision, ENTITY_TYPES, MAX_PAGE_CHARS, requireLivePage, wikiActor } from './pages.ts';
import { wikiPath } from './paths.ts';

export default defineOp({
  name: 'wiki_write',
  summary:
    'Replace the whole text of an existing wiki .md file. Pass the revision you read; a stale revision is refused. ' +
    'For small changes prefer wiki_replace or wiki_append; for a new file use wiki_create.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      path: wikiPath,
      body_md: z.string().max(MAX_PAGE_CHARS),
      expected_revision: z.number().int().min(1),
      entity_type: z.enum(ENTITY_TYPES).optional(),
      entity_id: z.uuid().optional(),
    })
    .strict()
    .refine((v) => (v.entity_type === undefined) === (v.entity_id === undefined), { message: 'entity_type and entity_id go together.' }),
  async handler(args, tx, ctx) {
    const page = await requireLivePage(tx, args.path);
    checkRevision(page, args.expected_revision);
    const entity = args.entity_type ? { entity_type: args.entity_type, entity_id: args.entity_id } : {};
    return changePage(tx, page, { body_md: args.body_md, ...entity }, 'edit', wikiActor(ctx));
  },
});
