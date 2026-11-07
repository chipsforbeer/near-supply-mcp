import { z } from 'zod';
import { defineOp } from '../define.ts';
import { appendText, changePage, createPage, livePage, wikiActor } from './pages.ts';
import { wikiPath } from './paths.ts';

const LOG = 'log.md';
const LOG_START = '# Log\n\nOne line per event, newest last: date, action, summary, pages, documents.\n';

export default defineOp({
  name: 'wiki_log_append',
  summary:
    'Add one dated line to the wiki\'s log.md: what happened (ingested a document, made a decision, checked the wiki, a note), ' +
    'with the pages and documents it concerns.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      action: z.enum(['ingest', 'decision', 'lint', 'query_writeback', 'note']),
      summary: z.string().trim().min(1).max(2000).refine((s) => !/[\r\n]/.test(s), { message: 'summary must be one line.' }),
      page_paths: z.array(wikiPath).max(50).optional(),
      document_ids: z.array(z.uuid()).max(50).optional(),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const at = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const parts = [`- ${at} UTC`, args.action, args.summary];
    if (args.page_paths?.length) parts.push(`pages: ${args.page_paths.join(', ')}`);
    if (args.document_ids?.length) parts.push(`documents: ${args.document_ids.join(', ')}`);
    const line = `${parts.join(' | ')}\n`;
    const actor = wikiActor(ctx);
    const page = await livePage(tx, LOG, true);
    const saved = page
      ? await changePage(tx, page, { body_md: appendText(page.body_md, line) }, 'edit', actor)
      : await createPage(tx, { path: LOG, body_md: LOG_START + line }, actor);
    return { ...saved, line: line.trimEnd() };
  },
});
