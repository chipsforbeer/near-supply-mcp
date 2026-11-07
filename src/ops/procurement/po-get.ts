import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';

export const poGet = defineOp({
  name: 'po_get',
  summary: 'One purchase order by po_id or po_code: lines with ordered and received quantities, approval and payment state.',
  kind: 'read',
  scope: 'read',
  input: z
    .object({ po_id: z.uuid().optional(), po_code: z.string().max(20).optional() })
    .strict()
    .refine((v) => (v.po_id === undefined) !== (v.po_code === undefined), { message: 'Give po_id or po_code.' }),
  async handler(args, tx) {
    const r = await tx.query(
      `SELECT p.id AS po_id, p.po_code, p.status, p.status_note, p.currency, p.freight_cost, p.total, p.approved_max_amount, p.approved_at,
              ua.email AS approved_by, p.payment_status, p.payment_network, p.payment_ref, p.payment_recorded_at, p.created_at,
              s.id AS supplier_id, s.name AS supplier, st.code AS site_code, q.id AS quote_id, r.rfq_code
         FROM purchase_order p JOIN supplier s ON s.id = p.supplier_id JOIN site st ON st.id = p.site_id
         LEFT JOIN app_user ua ON ua.id = p.approved_by LEFT JOIN quote q ON q.id = p.quote_id LEFT JOIN rfq r ON r.id = p.rfq_id
        WHERE ($1::uuid IS NOT NULL AND p.id = $1) OR ($2::text IS NOT NULL AND p.po_code = $2)`,
      [args.po_id ?? null, args.po_code ?? null],
    );
    const po = r.rows[0];
    if (!po) throw new OpError('not_found', 'Purchase order not found.');
    const lines = await tx.query(
      `SELECT l.id AS po_line_id, l.line_no, i.sku, i.name, i.base_uom, l.qty_base, l.price_per_base, l.received_qty_base
         FROM po_line l JOIN item i ON i.id = l.item_id WHERE l.po_id = $1 ORDER BY l.line_no`,
      [po.po_id],
    );
    return { ...po, lines: lines.rows };
  },
});

export const poStatusSet = defineOp({
  name: 'po_status_set',
  summary: 'Mark a PO sent (after emailing it), acknowledged (supplier confirmed) or cancelled, with a note.',
  kind: 'write',
  scope: 'write',
  input: z.object({ po_id: z.uuid(), status: z.enum(['sent', 'acknowledged', 'cancelled']), note: z.string().trim().min(3).max(1000) }).strict(),
  async handler(args, tx) {
    const cur = await tx.query('SELECT po_code, status, payment_status FROM purchase_order WHERE id = $1 FOR UPDATE', [args.po_id]);
    const po = cur.rows[0];
    if (!po) throw new OpError('not_found', 'Purchase order not found.');
    const allowed: Record<string, string[]> = {
      sent: ['approved'],
      acknowledged: ['approved', 'sent'],
      cancelled: ['draft', 'approved', 'sent', 'acknowledged'],
    };
    if (!allowed[args.status]!.includes(po.status)) throw new OpError('conflict', `${po.po_code} is ${po.status}; it cannot become ${args.status}.`);
    if (args.status === 'cancelled' && po.payment_status === 'paid') throw new OpError('conflict', `${po.po_code} is already paid.`);
    const r = await tx.query('UPDATE purchase_order SET status = $2, status_note = $3 WHERE id = $1 RETURNING po_code, status', [args.po_id, args.status, args.note]);
    return r.rows[0];
  },
});
