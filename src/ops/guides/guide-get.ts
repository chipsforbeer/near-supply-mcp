import { z } from 'zod';
import { defineOp } from '../define.ts';
import { GUIDE_MODULES, GUIDES } from './load.ts';

export default defineOp({
  name: 'guide_get',
  summary: 'Read the how-to guide for one module: the usual flow, which operations to call in what order, and what to watch for.',
  kind: 'read',
  scope: 'read',
  input: z.object({ module: z.enum(GUIDE_MODULES) }).strict(),
  async handler(args) {
    const g = GUIDES.find((x) => x.module === args.module)!;
    return { module: g.module, title: g.title, body_md: g.body_md };
  },
});
