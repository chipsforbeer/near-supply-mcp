import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { requirePo } from './po-common.ts';
import { nonNegativeDecimal } from '../schemas.ts';
import { cmp, dec } from '../../domain/decimal.ts';

export default defineOp({
  name: 'po_approve',
  summary:
    'Approve a draft purchase order (approve scope only) with the most that may be paid for it. The payment MCP can never pay more than approved_max_amount. Marks the RFQ awarded.',
  kind: 'write',
  scope: 'approve',
  input: z.object({ po_id: z.uuid(), approved_max_amount: nonNegativeDecimal }).strict(),
  async handler(args, tx, ctx) {
    const po = await requirePo(tx, args.po_id, true);
    if (po.status !== 'draft') throw new OpError('conflict', `${po.po_code} is ${po.status}, not draft.`);
    if (cmp(dec(args.approved_max_amount), dec(po.total)) < 0) {
      throw new OpError('invalid_arguments', `approved_max_amount must be at least the PO total of ${po.total} ${po.currency}.`);
    }
    const r = await tx.query(
      `UPDATE purchase_order SET status = 'approved', approved_by = $2, approved_at = now(), approved_max_amount = $3
        WHERE id = $1 RETURNING po_code, status, total, currency, approved_max_amount, approved_at`,
      [po.id, ctx.session.userId, args.approved_max_amount],
    );
    if (po.rfq_id) await tx.query(`UPDATE rfq SET status = 'awarded', status_note = $2 WHERE id = $1 AND status <> 'cancelled'`, [po.rfq_id, `Awarded as ${po.po_code}`]);
    return r.rows[0];
  },
});
