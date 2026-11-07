import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { requireItem, requireSite } from './common.ts';
import { nonNegativeDecimal, positiveDecimal, siteCode, unitFields } from '../schemas.ts';
import { loadItemUnits, toBase } from '../../domain/units.ts';

export default defineOp({
  name: 'reorder_policy_set',
  summary:
    'How an item is reordered at a site. days_of_cover: reorder when stock lasts less than lead time + safety_days, order up to target_cover_days of use. min_max: reorder at min, order up to max (min/max in any unit or pack). manual: never flagged.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      item_id: z.uuid(),
      site_code: siteCode,
      method: z.enum(['days_of_cover', 'min_max', 'manual']),
      min_qty: nonNegativeDecimal.optional(),
      max_qty: positiveDecimal.optional(),
      ...unitFields,
      safety_days: z.number().min(0).max(365).optional(),
      target_cover_days: z.number().gt(0).max(730).optional(),
      lead_time_override: z.number().int().min(0).max(730).optional(),
      usage_window_days: z.number().int().min(7).max(365).optional(),
    })
    .strict(),
  async handler(args, tx) {
    const item = await requireItem(tx, args.item_id);
    const site = await requireSite(tx, args.site_code);
    const units = await loadItemUnits(tx, item.id);
    const min = args.min_qty !== undefined ? toBase(args.min_qty, { uom: args.uom, pack: args.pack }, units) : null;
    const max = args.max_qty !== undefined ? toBase(args.max_qty, { uom: args.uom, pack: args.pack }, units) : null;
    if (args.method === 'min_max' && (min === null || max === null)) throw new OpError('invalid_arguments', 'min_max needs min_qty and max_qty.');
    if (args.method === 'days_of_cover' && (args.safety_days === undefined || args.target_cover_days === undefined)) {
      throw new OpError('invalid_arguments', 'days_of_cover needs safety_days and target_cover_days.');
    }
    const r = await tx.query(
      `INSERT INTO reorder_policy (item_id, site_id, method, min_qty_base, max_qty_base, safety_days, target_cover_days, lead_time_override, usage_window_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, 30))
       ON CONFLICT (company_id, item_id, site_id) DO UPDATE SET
         method = EXCLUDED.method, min_qty_base = EXCLUDED.min_qty_base, max_qty_base = EXCLUDED.max_qty_base,
         safety_days = EXCLUDED.safety_days, target_cover_days = EXCLUDED.target_cover_days,
         lead_time_override = EXCLUDED.lead_time_override, usage_window_days = EXCLUDED.usage_window_days, updated_at = now()
       RETURNING method, min_qty_base, max_qty_base, safety_days, target_cover_days, lead_time_override, usage_window_days`,
      [item.id, site.id, args.method, min, max, args.safety_days ?? null, args.target_cover_days ?? null, args.lead_time_override ?? null,
        args.usage_window_days ?? null],
    );
    return { sku: item.sku, site_code: site.code, base_uom: units.baseUom, ...r.rows[0] };
  },
});
