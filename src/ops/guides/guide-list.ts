import { z } from 'zod';
import { defineOp } from '../define.ts';
import { GUIDES } from './load.ts';

export default defineOp({
  name: 'guide_list',
  summary:
    'The how-to guide for each module (basics, inventory, production, suppliers, outreach, buying, specs, documents, wiki, ' +
    'sql, access): title, summary and the operations it covers. Read basics first, and guide_get a module before using it.',
  kind: 'read',
  scope: 'read',
  input: z.object({}).strict(),
  async handler() {
    // Imported here: the catalogue imports this operation.
    const { ops } = await import('../catalogue.ts');
    return {
      guides: GUIDES.map((g) => ({
        module: g.module,
        title: g.title,
        summary: g.summary,
        operations: [...new Set([...g.body_md.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!).filter((n) => ops.has(n)))],
      })),
    };
  },
});
