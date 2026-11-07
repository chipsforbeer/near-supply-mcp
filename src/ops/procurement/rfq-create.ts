import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { brandIdFor, requireItem, requireSite } from '../inventory/common.ts';
import { isoDate, positiveDecimal, siteCode, unitFields } from '../schemas.ts';
import { loadItemUnits, toBase } from '../../domain/units.ts';

export default defineOp({
  name: 'rfq_create',
  summary:
    'Start a request for quotation: what items, how much (any unit or pack), needed by when, delivered to which site. Then add recipients and contact them.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      site_code: siteCode,
      brand: z.string().trim().min(1).max(120).optional(),
      trigger: z.enum(['low_stock', 'manual', 'project']),
      needed_by: isoDate.optional(),
      notes: z.string().max(4000).optional(),
      lines: z
        .array(
          z
            .object({
              item_id: z.uuid(),
              qty: positiveDecimal,
              ...unitFields,
              preferred_pack: z.string().max(120).optional(),
              notes: z.string().max(2000).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const site = await requireSite(tx, args.site_code);
    const brandId = await brandIdFor(tx, args.brand);
    const n = await tx.query('SELECT count(*)::int + 1 AS next FROM rfq');
    const code = `RFQ-${String(n.rows[0].next).padStart(4, '0')}`;
    const r = await tx.query(
      `INSERT INTO rfq (rfq_code, site_id, brand_id, trigger, needed_by, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, rfq_code, status, trigger, needed_by`,
      [code, site.id, brandId, args.trigger, args.needed_by ?? null, args.notes ?? null, ctx.session.userId],
    );
    const rfq = r.rows[0];
    const lines = [];
    let no = 0;
    for (const line of args.lines) {
      no += 1;
      const item = await requireItem(tx, line.item_id);
      const units = await loadItemUnits(tx, item.id);
      const qtyBase = toBase(line.qty, { uom: line.uom, pack: line.pack }, units);
      let packId: string | null = null;
      if (line.preferred_pack) {
        const p = await tx.query('SELECT id FROM item_pack WHERE item_id = $1 AND lower(name) = lower($2)', [item.id, line.preferred_pack]);
        if (!p.rows[0]) throw new OpError('not_found', `No pack "${line.preferred_pack}" on ${item.sku}.`);
        packId = p.rows[0].id;
      }
      // Suppliers quote against the item's active spec at the time the RFQ is made.
      const spec = await tx.query(`SELECT id FROM item_spec WHERE item_id = $1 AND status = 'active'`, [item.id]);
      const l = await tx.query(
        `INSERT INTO rfq_line (rfq_id, line_no, item_id, qty_base, preferred_pack_id, spec_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, line_no, qty_base, spec_id`,
        [rfq.id, no, item.id, qtyBase, packId, spec.rows[0]?.id ?? null, line.notes ?? null],
      );
      lines.push({ ...l.rows[0], item_id: item.id, sku: item.sku, base_uom: units.baseUom });
    }
    return { rfq_id: rfq.id, ...rfq, lines };
  },
});
