import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { addMethod, methodSchema, requireSupplier } from './common.ts';

export default defineOp({
  name: 'contact_method_add',
  summary:
    'Add a way to reach a supplier: email, phone, WhatsApp, LINE, WeChat, portal... for a contact (contact_id) or the whole company (no contact_id, e.g. sales@). do_not_contact marks it as never to be used.',
  kind: 'write',
  scope: 'write',
  input: methodSchema.extend({ supplier_id: z.uuid(), contact_id: z.uuid().optional() }).strict(),
  async handler(args, tx) {
    await requireSupplier(tx, args.supplier_id);
    if (args.contact_id) {
      const c = await tx.query('SELECT 1 FROM contact WHERE id = $1 AND supplier_id = $2', [args.contact_id, args.supplier_id]);
      if (!c.rowCount) throw new OpError('not_found', 'Contact not found for that supplier.');
    }
    const { supplier_id, contact_id, ...method } = args;
    return addMethod(tx, supplier_id, contact_id ?? null, method);
  },
});
