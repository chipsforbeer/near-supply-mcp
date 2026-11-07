import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { requireSupplier } from '../suppliers/common.ts';
import { requireItem } from '../inventory/common.ts';
import { requireRfq } from './common.ts';
import { currency, isoDate, isoDateTime, nonNegativeDecimal, positiveDecimal } from '../schemas.ts';
import { loadItemUnits, toBase } from '../../domain/units.ts';
import { dec, div, str } from '../../domain/decimal.ts';

export default defineOp({
  name: 'quote_record',
  summary:
    'Record a quote exactly as the supplier gave it: what one priced unit is (pack_qty + pack or pack_uom, e.g. 1 x "25 kg sack", or 1000 each), price per that unit, MOQ, tooling, volume breaks, freight, currency, validity. Cite the source document.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      rfq_id: z.uuid().optional(),
      supplier_id: z.uuid(),
      quote_ref: z.string().max(120).optional(),
      received_at: isoDateTime,
      valid_until: isoDate.optional(),
      currency,
      incoterms: z.string().max(40).optional(),
      payment_terms: z.string().max(200).optional(),
      lead_time_days: z.number().int().min(0).max(730).optional(),
      freight_cost: nonNegativeDecimal.optional(),
      source_document_id: z.uuid().optional(),
      interaction_id: z.uuid().optional(),
      notes: z.string().max(4000).optional(),
      lines: z
        .array(
          z
            .object({
              rfq_line_id: z.uuid().optional(),
              item_id: z.uuid(),
              pack_desc: z.string().max(200).optional(),
              pack_qty: positiveDecimal,
              pack_uom: z.string().max(10).optional(),
              pack: z.string().max(120).optional(),
              price_per_pack: nonNegativeDecimal,
              moq_packs: positiveDecimal.optional(),
              tooling_cost: nonNegativeDecimal.optional(),
              lead_time_days: z.number().int().min(0).max(730).optional(),
              breaks: z.array(z.object({ min_packs: positiveDecimal, price_per_pack: nonNegativeDecimal }).strict()).max(20).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const supplier = await requireSupplier(tx, args.supplier_id);
    if (args.rfq_id) {
      await requireRfq(tx, args.rfq_id);
      const rr = await tx.query('SELECT 1 FROM rfq_recipient WHERE rfq_id = $1 AND supplier_id = $2', [args.rfq_id, supplier.id]);
      if (!rr.rowCount) throw new OpError('conflict', 'This supplier is not a recipient of that RFQ.');
    }
    for (const [id, table] of [[args.source_document_id, 'document'], [args.interaction_id, 'interaction']] as const) {
      if (id) {
        const r = await tx.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
        if (!r.rowCount) throw new OpError('not_found', `${table} ${id} not found.`);
      }
    }
    const q = await tx.query(
      `INSERT INTO quote (rfq_id, supplier_id, quote_ref, received_at, valid_until, currency, incoterms, payment_terms, lead_time_days,
                          freight_cost, source_document_id, interaction_id, notes, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id, currency, received_at`,
      [args.rfq_id ?? null, supplier.id, args.quote_ref ?? null, args.received_at, args.valid_until ?? null, args.currency,
        args.incoterms ?? null, args.payment_terms ?? null, args.lead_time_days ?? null, args.freight_cost ?? null,
        args.source_document_id ?? null, args.interaction_id ?? null, args.notes ?? null, ctx.session.userId],
    );
    const quoteId = q.rows[0].id as string;
    const lines = [];
    for (const line of args.lines) {
      const item = await requireItem(tx, line.item_id);
      if (line.rfq_line_id) {
        const l = await tx.query('SELECT item_id, rfq_id FROM rfq_line WHERE id = $1', [line.rfq_line_id]);
        if (!l.rows[0] || l.rows[0].rfq_id !== args.rfq_id || l.rows[0].item_id !== item.id) {
          throw new OpError('invalid_arguments', 'rfq_line_id must be a line of the same RFQ for the same item.');
        }
      }
      const units = await loadItemUnits(tx, item.id);
      const packBase = toBase(line.pack_qty, { uom: line.pack_uom, pack: line.pack }, units);
      const ql = await tx.query(
        `INSERT INTO quote_line (quote_id, rfq_line_id, item_id, pack_desc, pack_base_qty, price_per_pack, moq_packs, tooling_cost, lead_time_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, pack_base_qty, price_per_pack, price_per_base`,
        [quoteId, line.rfq_line_id ?? null, item.id, line.pack_desc ?? line.pack ?? `${line.pack_qty} ${line.pack_uom ?? units.baseUom}`,
          packBase, line.price_per_pack, line.moq_packs ?? null, line.tooling_cost ?? null, line.lead_time_days ?? null],
      );
      for (const b of line.breaks ?? []) {
        await tx.query('INSERT INTO quote_line_break (quote_line_id, min_packs, price_per_pack) VALUES ($1, $2, $3)', [ql.rows[0].id, b.min_packs, b.price_per_pack]);
      }
      // Keep the supplier's last known price and lead time for this item.
      await tx.query(
        `INSERT INTO supplier_item (supplier_id, item_id, last_price, last_price_per, last_price_currency, last_priced_at, lead_time_days)
         VALUES ($1, $2, $3, 'base', $4, $5::timestamptz::date, $6)
         ON CONFLICT (company_id, supplier_id, item_id) DO UPDATE SET
           last_price = EXCLUDED.last_price, last_price_per = 'base', last_price_currency = EXCLUDED.last_price_currency,
           last_priced_at = EXCLUDED.last_priced_at, lead_time_days = coalesce(EXCLUDED.lead_time_days, supplier_item.lead_time_days)`,
        [supplier.id, item.id, str(div(dec(line.price_per_pack), dec(packBase))), args.currency, args.received_at,
          line.lead_time_days ?? args.lead_time_days ?? null],
      );
      lines.push({ quote_line_id: ql.rows[0].id, item_id: item.id, sku: item.sku, ...ql.rows[0], base_uom: units.baseUom });
    }
    if (args.rfq_id) {
      await tx.query(`UPDATE rfq_recipient SET status = 'quoted' WHERE rfq_id = $1 AND supplier_id = $2 AND status <> 'disqualified'`, [args.rfq_id, supplier.id]);
      await tx.query(`UPDATE rfq SET status = 'quoting' WHERE id = $1 AND status IN ('draft','sent')`, [args.rfq_id]);
    }
    return { quote_id: quoteId, supplier: supplier.name, currency: args.currency, lines };
  },
});
