import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { requireSupplier, setList } from './common.ts';
import { requireItem } from '../inventory/common.ts';
import { currency, isoDate, nonNegativeDecimal, positiveDecimal } from '../schemas.ts';
import { loadItemUnits, toBase } from '../../domain/units.ts';

const COLUMNS: Record<string, string> = {
  supplier_sku: 'supplier_sku', supplier_item_name: 'supplier_item_name', purchase_pack_id: 'purchase_pack_id', moq_base: 'moq_base',
  lead_time_days: 'lead_time_days', last_price: 'last_price', last_price_per: 'last_price_per',
  last_price_currency: 'last_price_currency', last_priced_at: 'last_priced_at', is_preferred: 'is_preferred',
};
const RETURNING = `id, supplier_id, item_id, supplier_sku, supplier_item_name, purchase_pack_id, moq_base, lead_time_days, last_price,
  last_price_per, last_price_currency, last_priced_at, is_preferred`;

export default defineOp({
  name: 'supplier_item_upsert',
  summary:
    'Record that a supplier sells us an item: their SKU, the pack they sell (purchase_pack), minimum order, lead time and last price. ' +
    'One supplier per item can be preferred. Updating changes only the fields passed; null clears one.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      supplier_id: z.uuid(),
      item_id: z.uuid(),
      supplier_sku: z.string().max(80).nullable().optional(),
      supplier_item_name: z.string().max(200).nullable().optional(),
      purchase_pack: z.string().max(120).nullable().optional(),
      moq: positiveDecimal.nullable().optional(),
      moq_uom: z.string().max(10).optional(),
      moq_pack: z.string().max(120).optional(),
      lead_time_days: z.number().int().min(0).max(730).nullable().optional(),
      last_price: nonNegativeDecimal.nullable().optional(),
      last_price_per: z.enum(['base', 'pack']).nullable().optional(),
      last_price_currency: currency.nullable().optional(),
      last_priced_at: isoDate.nullable().optional(),
      is_preferred: z.boolean().optional(),
    })
    .strict(),
  async handler(args, tx) {
    await requireSupplier(tx, args.supplier_id);
    await requireItem(tx, args.item_id);
    const units = await loadItemUnits(tx, args.item_id);
    // undefined keeps the current pack, null clears it, a name sets it.
    let packId: string | null | undefined = args.purchase_pack === null ? null : undefined;
    if (args.purchase_pack) {
      const p = await tx.query('SELECT id FROM item_pack WHERE item_id = $1 AND (lower(name) = lower($2) OR id::text = $2)', [args.item_id, args.purchase_pack]);
      if (!p.rows[0]) throw new OpError('not_found', `No pack "${args.purchase_pack}" on this item; define it with item_pack_upsert.`);
      packId = p.rows[0].id;
    }
    const moqBase = args.moq === null ? null : args.moq ? toBase(args.moq, { uom: args.moq_uom, pack: args.moq_pack }, units) : undefined;
    const existing = (
      await tx.query('SELECT id, purchase_pack_id FROM supplier_item WHERE supplier_id = $1 AND item_id = $2 FOR UPDATE', [args.supplier_id, args.item_id])
    ).rows[0] as { id: string; purchase_pack_id: string | null } | undefined;
    const packAfter = packId !== undefined ? packId : (existing?.purchase_pack_id ?? null);
    if (args.last_price_per === 'pack' && !packAfter) throw new OpError('invalid_arguments', 'A per-pack price needs purchase_pack.');
    if (args.is_preferred) await tx.query('UPDATE supplier_item SET is_preferred = false WHERE item_id = $1 AND supplier_id <> $2', [args.item_id, args.supplier_id]);

    if (!existing) {
      const r = await tx.query(
        `INSERT INTO supplier_item (supplier_id, item_id, supplier_sku, supplier_item_name, purchase_pack_id, moq_base, lead_time_days,
                                    last_price, last_price_per, last_price_currency, last_priced_at, is_preferred)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce($12, false))
         RETURNING ${RETURNING}`,
        [args.supplier_id, args.item_id, args.supplier_sku ?? null, args.supplier_item_name ?? null, packId ?? null, moqBase ?? null,
          args.lead_time_days ?? null, args.last_price ?? null, args.last_price_per ?? null, args.last_price_currency ?? null,
          args.last_priced_at ?? null, args.is_preferred ?? null],
      );
      return r.rows[0];
    }
    const set = setList(COLUMNS, { ...args, purchase_pack_id: packId, moq_base: moqBase }, 2);
    const r = await tx.query(
      set.sql.length
        ? `UPDATE supplier_item SET ${set.sql.join(', ')} WHERE id = $1 RETURNING ${RETURNING}`
        : `SELECT ${RETURNING} FROM supplier_item WHERE id = $1`,
      [existing.id, ...set.values],
    );
    return r.rows[0];
  },
});
