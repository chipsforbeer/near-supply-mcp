import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { addMethod, contactFields, findDuplicates, insertContact, methodSchema, offeringFields, supplierFields } from './common.ts';
import { saveOffering } from './details.ts';
import { saveSupplier } from './save.ts';

const row = z
  .object({
    ...supplierFields,
    origin: z.enum(['existing', 'discovered']).default('existing'),
    methods: z.array(methodSchema).max(20).optional(),
    contacts: z.array(z.object({ ...contactFields, methods: z.array(methodSchema).max(20).optional() }).strict()).max(50).optional(),
    offerings: z.array(z.object(offeringFields).strict()).max(50).optional(),
  })
  .strict();

export default defineOp({
  name: 'supplier_import',
  summary:
    "Load the factory's existing supplier list in one call (up to 200), with contacts and how to reach them, and offerings. " +
    'Likely duplicates are reported, never merged or overwritten.',
  kind: 'write',
  scope: 'write',
  input: z.object({ suppliers: z.array(row).min(1).max(200) }).strict(),
  async handler(args, tx) {
    const results = [];
    for (const [index, s] of args.suppliers.entries()) {
      const firstEmail = s.methods?.find((m) => m.type === 'email')?.value ?? s.contacts?.flatMap((c) => c.methods ?? []).find((m) => m.type === 'email')?.value;
      const firstPhone = s.methods?.find((m) => m.type === 'phone' || m.type === 'mobile')?.value;
      const matches = await findDuplicates(tx, { name: s.name, website: s.website ?? undefined, email: firstEmail, phone: firstPhone });
      if (matches.length) {
        results.push({ index, name: s.name, result: 'duplicate', matches });
        continue;
      }
      const { methods, contacts, offerings, ...fields } = s;
      const saved = await saveSupplier(tx, { ...fields, allow_similar: true });
      const supplierId = saved.supplier.id as string;
      for (const m of methods ?? []) await addMethod(tx, supplierId, null, m);
      for (const o of offerings ?? []) await saveOffering(tx, supplierId, o);
      for (const c of contacts ?? []) {
        const { methods: cm, ...contact } = c;
        const contactId = await insertContact(tx, supplierId, contact);
        for (const m of cm ?? []) await addMethod(tx, supplierId, contactId, m);
      }
      results.push({ index, name: s.name, result: 'created', supplier_id: supplierId });
    }
    if (results.length !== args.suppliers.length) throw new OpError('internal', 'Import count mismatch.');
    return {
      created: results.filter((r) => r.result === 'created').length,
      duplicates: results.filter((r) => r.result === 'duplicate').length,
      results,
    };
  },
});
