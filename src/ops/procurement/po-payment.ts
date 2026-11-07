import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { requirePo } from './po-common.ts';
import { cmp, dec } from '../../domain/decimal.ts';

export const poPaymentInstruction = defineOp({
  name: 'po_payment_instruction',
  summary:
    'Get what the payment MCP needs to pay an approved PO: payout account, token, amount, currency and the approval. Refused unless approved, a payout account is set and the amount is within the approved maximum. Marks the PO instructed.',
  kind: 'write',
  scope: 'write',
  input: z.object({ po_id: z.uuid() }).strict(),
  async handler(args, tx) {
    const po = await requirePo(tx, args.po_id, true);
    if (!po.approved_at || po.status === 'draft' || po.status === 'cancelled') {
      throw new OpError('conflict', `${po.po_code} is not approved for payment.`);
    }
    if (po.payment_status === 'paid') throw new OpError('conflict', `${po.po_code} is already paid.`);
    if (po.payment_status === 'instructed') throw new OpError('conflict', `${po.po_code} already has an open payment instruction; record its outcome first.`);
    if (cmp(dec(po.total), dec(po.approved_max_amount ?? '0')) > 0) {
      throw new OpError('conflict', `${po.po_code} total ${po.total} is above the approved maximum ${po.approved_max_amount}.`);
    }
    const acct = await tx.query(
      `SELECT a.network, a.account_id, a.token, s.name FROM supplier_payout_account a JOIN supplier s ON s.id = a.supplier_id
        WHERE a.supplier_id = $1 AND a.superseded_at IS NULL ORDER BY a.set_at DESC LIMIT 1`,
      [po.supplier_id],
    );
    if (!acct.rows[0]) throw new OpError('conflict', 'The supplier has no payout account; an approver must set one with supplier_payout_account_set.');
    const approver = await tx.query('SELECT email FROM app_user WHERE id = $1', [po.approved_by]);
    await tx.query(`UPDATE purchase_order SET payment_status = 'instructed' WHERE id = $1`, [po.id]);
    return {
      po_id: po.id,
      po_code: po.po_code,
      supplier_name: acct.rows[0].name,
      network: acct.rows[0].network,
      account_id: acct.rows[0].account_id,
      token: acct.rows[0].token,
      amount: po.total,
      currency: po.currency,
      approval: { approved_by: approver.rows[0]?.email ?? null, approved_at: po.approved_at, approved_max_amount: po.approved_max_amount },
    };
  },
});

export const poPaymentRecord = defineOp({
  name: 'po_payment_record',
  summary: 'Record the outcome the payment MCP reported for an instructed PO: paid (with the transaction reference) or failed.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      po_id: z.uuid(),
      network: z.literal('near'),
      payment_ref: z.string().trim().min(4).max(200),
      outcome: z.enum(['paid', 'failed']),
      note: z.string().max(1000).optional(),
    })
    .strict(),
  async handler(args, tx) {
    const po = await requirePo(tx, args.po_id, true);
    if (po.payment_status !== 'instructed') throw new OpError('conflict', `${po.po_code} has no open payment instruction (status ${po.payment_status}).`);
    const r = await tx.query(
      `UPDATE purchase_order SET payment_status = $2, payment_network = $3, payment_ref = $4, payment_recorded_at = now(),
              status_note = coalesce($5, status_note)
        WHERE id = $1 RETURNING po_code, payment_status, payment_network, payment_ref, payment_recorded_at`,
      [po.id, args.outcome, args.network, args.payment_ref, args.note ?? null],
    );
    return r.rows[0];
  },
});
