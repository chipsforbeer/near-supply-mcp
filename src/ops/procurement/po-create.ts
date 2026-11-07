import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { requireItem, requireSite } from '../inventory/common.ts';
import { requireSupplier } from '../suppliers/common.ts';
import { currency, nonNegativeDecimal, positiveDecimal, siteCode, unitFields } from '../schemas.ts';
import { loadItemUnits, toBase } from '../../domain/units.ts';
import { add, dec, mul, str } from '../../domain/decimal.ts';

export default defineOp({
  name: 'po_create',
  summary:
    'Draft a purchase order to a supplier (optionally from a quote): lines with quantity in any unit or pack and price per base unit, plus freight. It needs po_approve before it can be paid or received.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      supplier_id: z.uuid(),
      site_code: siteCode,
      quote_id: z.uuid().optional(),
      currency,
      freight_cost: nonNegativeDecimal.optional(),
      notes: z.string().max(4000).optional(),
      lines: z
        .array(z.object({ item_id: z.uuid(), qty: positiveDecimal, ...unitFields, price_per_base: nonNegativeDecimal, quote_line_id: z.uuid().optional() }).strict())
        .min(1)
        .max(100),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const supplier = await requireSupplier(tx, args.supplier_id);
    if (supplier.status === 'blocked' || supplier.status === 'on_hold') throw new OpError('conflict', `${supplier.name} is ${supplier.status}.`);
    const site = await requireSite(tx, args.site_code);
    let rfqId: string | null = null;
    if (args.quote_id) {
      const q = await tx.query('SELECT supplier_id, currency, rfq_id FROM quote WHERE id = $1', [args.quote_id]);
      if (!q.rows[0]) throw new OpError('not_found', 'Quote not found.');
      if (q.rows[0].supplier_id !== supplier.id) throw new OpError('invalid_arguments', 'That quote is from a different supplier.');
      if (q.rows[0].currency !== args.currency) throw new OpError('invalid_arguments', `The quote is in ${q.rows[0].currency}.`);
      rfqId = q.rows[0].rfq_id;
    }
    const lines = [];
    let total = dec(args.freight_cost ?? '0');
    for (const line of args.lines) {
      const item = await requireItem(tx, line.item_id);
      if (line.quote_line_id) {
        const ql = await tx.query('SELECT quote_id, item_id FROM quote_line WHERE id = $1', [line.quote_line_id]);
        if (!ql.rows[0] || ql.rows[0].quote_id !== args.quote_id || ql.rows[0].item_id !== item.id) {
          throw new OpError('invalid_arguments', 'quote_line_id must belong to quote_id and the same item.');
        }
      }
      const qtyBase = toBase(line.qty, { uom: line.uom, pack: line.pack }, await loadItemUnits(tx, item.id));
      total = add(total, mul(dec(qtyBase), dec(line.price_per_base)));
      lines.push({ item_id: item.id, sku: item.sku, qty_base: qtyBase, price_per_base: line.price_per_base, quote_line_id: line.quote_line_id ?? null });
    }
    const n = await tx.query('SELECT count(*)::int + 1 AS next FROM purchase_order');
    const code = `PO-${String(n.rows[0].next).padStart(4, '0')}`;
    const po = await tx.query(
      `INSERT INTO purchase_order (po_code, supplier_id, quote_id, rfq_id, site_id, currency, freight_cost, total, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, po_code, status, currency, total, payment_status`,
      [code, supplier.id, args.quote_id ?? null, rfqId, site.id, args.currency, args.freight_cost ?? '0', str(total, 2), args.notes ?? null, ctx.session.userId],
    );
    let no = 0;
    const saved = [];
    for (const l of lines) {
      no += 1;
      const r = await tx.query(
        `INSERT INTO po_line (po_id, line_no, item_id, quote_line_id, qty_base, price_per_base) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id AS po_line_id, line_no, qty_base, price_per_base`,
        [po.rows[0].id, no, l.item_id, l.quote_line_id, l.qty_base, l.price_per_base],
      );
      saved.push({ ...r.rows[0], sku: l.sku });
    }
    return { po_id: po.rows[0].id, ...po.rows[0], supplier: supplier.name, lines: saved };
  },
});
