import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { limit } from '../schemas.ts';
import { sequential } from '../../db/pool.ts';

export const rfqGet = defineOp({
  name: 'rfq_get',
  summary: 'One RFQ with its lines (item, quantity, spec version) and recipients.',
  kind: 'read',
  scope: 'read',
  input: z.object({ rfq_id: z.uuid().optional(), rfq_code: z.string().max(20).optional() }).strict()
    .refine((v) => (v.rfq_id === undefined) !== (v.rfq_code === undefined), { message: 'Give rfq_id or rfq_code.' }),
  async handler(args, tx) {
    const r = await tx.query(
      `SELECT r.id AS rfq_id, r.rfq_code, r.status, r.trigger, r.needed_by, r.notes, r.status_note, r.created_at, s.code AS site_code
         FROM rfq r JOIN site s ON s.id = r.site_id
        WHERE ($1::uuid IS NOT NULL AND r.id = $1) OR ($2::text IS NOT NULL AND r.rfq_code = $2)`,
      [args.rfq_id ?? null, args.rfq_code ?? null],
    );
    const rfq = r.rows[0];
    if (!rfq) throw new OpError('not_found', 'RFQ not found.');
    const [lines, recipients] = await sequential([
      () => tx.query(
        `SELECT l.id AS rfq_line_id, l.line_no, l.item_id, i.sku, i.name, i.base_uom, l.qty_base, p.name AS preferred_pack, l.spec_id, l.notes
           FROM rfq_line l JOIN item i ON i.id = l.item_id LEFT JOIN item_pack p ON p.id = l.preferred_pack_id
          WHERE l.rfq_id = $1 ORDER BY l.line_no`,
        [rfq.rfq_id],
      ),
      () => tx.query(
        `SELECT rr.supplier_id, s.name AS supplier, rr.status, rr.follow_ups FROM rfq_recipient rr JOIN supplier s ON s.id = rr.supplier_id
          WHERE rr.rfq_id = $1 ORDER BY s.name`,
        [rfq.rfq_id],
      ),
    ]);
    return { ...rfq, lines: lines.rows, recipients: recipients.rows };
  },
});

export const rfqList = defineOp({
  name: 'rfq_list',
  summary: 'Recent RFQs, optionally by status or by an item they include.',
  kind: 'read',
  scope: 'read',
  input: z
    .object({ status: z.enum(['draft', 'sent', 'quoting', 'awarded', 'cancelled']).optional(), item_id: z.uuid().optional(), limit: limit(100, 25) })
    .strict(),
  async handler(args, tx) {
    const r = await tx.query(
      `SELECT r.id AS rfq_id, r.rfq_code, r.status, r.trigger, r.needed_by, r.created_at,
              (SELECT count(*) FROM rfq_recipient rr WHERE rr.rfq_id = r.id)::int AS recipients
         FROM rfq r
        WHERE ($1::text IS NULL OR r.status = $1)
          AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM rfq_line l WHERE l.rfq_id = r.id AND l.item_id = $2))
        ORDER BY r.created_at DESC LIMIT $3`,
      [args.status ?? null, args.item_id ?? null, args.limit],
    );
    return { items: r.rows };
  },
});

export const rfqStatusSet = defineOp({
  name: 'rfq_status_set',
  summary: 'Close an RFQ as awarded or cancelled, or mark a recipient declined / no_response / disqualified, with a note.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      rfq_id: z.uuid(),
      status: z.enum(['quoting', 'awarded', 'cancelled']).optional(),
      supplier_id: z.uuid().optional(),
      recipient_status: z.enum(['declined', 'no_response', 'disqualified']).optional(),
      note: z.string().trim().min(3).max(1000),
    })
    .strict()
    .refine((v) => Boolean(v.status) !== Boolean(v.recipient_status), { message: 'Give status, or supplier_id with recipient_status.' })
    .refine((v) => !v.recipient_status || v.supplier_id, { message: 'recipient_status needs supplier_id.' }),
  async handler(args, tx) {
    if (args.status) {
      const r = await tx.query('UPDATE rfq SET status = $2, status_note = $3 WHERE id = $1 RETURNING rfq_code, status', [args.rfq_id, args.status, args.note]);
      if (!r.rows[0]) throw new OpError('not_found', 'RFQ not found.');
      return r.rows[0];
    }
    const r = await tx.query(
      'UPDATE rfq_recipient SET status = $3, status_note = $4 WHERE rfq_id = $1 AND supplier_id = $2 RETURNING status',
      [args.rfq_id, args.supplier_id, args.recipient_status, args.note],
    );
    if (!r.rows[0]) throw new OpError('not_found', 'That supplier is not a recipient of this RFQ.');
    return { supplier_id: args.supplier_id, ...r.rows[0] };
  },
});
