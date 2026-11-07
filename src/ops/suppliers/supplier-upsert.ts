import { z } from 'zod';
import { defineOp } from '../define.ts';
import { supplierFields } from './common.ts';
import { saveSupplier } from './save.ts';

export default defineOp({
  name: 'supplier_upsert',
  summary:
    'Create a supplier (origin existing = already buying from them; discovered = found on request, with discovery_sources URLs) or update one by supplier_id. Creation refuses likely duplicates (same name, company email domain) unless allow_similar.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      supplier_id: z.uuid().optional(),
      ...supplierFields,
      name: supplierFields.name.optional(),
      allow_similar: z.boolean().optional(),
    })
    .strict(),
  async handler(args, tx) {
    return saveSupplier(tx, args);
  },
});
