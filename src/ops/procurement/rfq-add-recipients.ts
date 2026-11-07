import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { requireRfq } from './common.ts';

export default defineOp({
  name: 'rfq_add_recipients',
  summary:
    'Choose which suppliers (and which contact at each) to ask for a quote. Blocked suppliers and contacts we may not contact on the user\'s behalf are refused.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      rfq_id: z.uuid(),
      recipients: z.array(z.object({ supplier_id: z.uuid(), contact_id: z.uuid().optional() }).strict()).min(1).max(50),
    })
    .strict(),
  async handler(args, tx) {
    const rfq = await requireRfq(tx, args.rfq_id);
    if (rfq.status === 'awarded' || rfq.status === 'cancelled') throw new OpError('conflict', `RFQ ${rfq.rfq_code} is ${rfq.status}.`);
    const added = [];
    for (const r of args.recipients) {
      const s = await tx.query('SELECT id, name, status FROM supplier WHERE id = $1', [r.supplier_id]);
      const supplier = s.rows[0];
      if (!supplier) throw new OpError('not_found', `Supplier ${r.supplier_id} not found.`);
      if (supplier.status === 'blocked' || supplier.status === 'on_hold') {
        throw new OpError('conflict', `${supplier.name} is ${supplier.status}; it cannot be asked for quotes.`);
      }
      if (r.contact_id) {
        const c = await tx.query('SELECT full_name, may_contact_on_behalf, status FROM contact WHERE id = $1 AND supplier_id = $2', [r.contact_id, r.supplier_id]);
        const contact = c.rows[0];
        if (!contact) throw new OpError('not_found', `Contact not found at ${supplier.name}.`);
        if (!contact.may_contact_on_behalf || contact.status !== 'active') {
          throw new OpError('conflict', `${contact.full_name} at ${supplier.name} must not be contacted on the user's behalf.`);
        }
      }
      const ins = await tx.query(
        `INSERT INTO rfq_recipient (rfq_id, supplier_id, contact_id) VALUES ($1, $2, $3)
         ON CONFLICT (company_id, rfq_id, supplier_id) DO NOTHING RETURNING status`,
        [rfq.id, r.supplier_id, r.contact_id ?? null],
      );
      added.push({ supplier_id: r.supplier_id, name: supplier.name, result: ins.rowCount ? 'added' : 'already_on_rfq' });
    }
    return { rfq_code: rfq.rfq_code, recipients: added };
  },
});
