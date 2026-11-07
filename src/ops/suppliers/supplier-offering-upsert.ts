import { z } from 'zod';
import { defineOp } from '../define.ts';
import { offeringFields, requireSupplier } from './common.ts';
import { saveOffering } from './details.ts';

export default defineOp({
  name: 'supplier_offering_upsert',
  summary:
    "Record what a supplier can supply in general, beyond the items we already buy from them: a product or service category, " +
    'description (grades, sizes, processes), tags, minimum order, lead time range, price note, where it came from and an optional ' +
    'catalogue or price list document. Pass offering_id to update one; set status discontinued instead of deleting.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      supplier_id: z.uuid(),
      offering_id: z.uuid().optional(),
      ...offeringFields,
      kind: offeringFields.kind.optional(),
      category: offeringFields.category.optional(),
    })
    .strict(),
  async handler(args, tx) {
    const { supplier_id, ...offering } = args;
    await requireSupplier(tx, supplier_id);
    return saveOffering(tx, supplier_id, offering);
  },
});
