import { z } from 'zod';
import { defineOp } from '../define.ts';
import { siteCode } from '../schemas.ts';
import { add, ceilCount, cmp, dec, div, mul, str, sub, times, type Dec } from '../../domain/decimal.ts';
import { describeInPacks } from '../../domain/units.ts';
import { packsByItem } from './stock-levels.ts';

export type ReorderStatus = 'critical' | 'reorder' | 'ok' | 'needs_lead_time' | 'needs_usage_history';

export type ReorderInput = {
  method: 'min_max' | 'days_of_cover';
  on_hand: string;
  on_order: string;
  daily_usage: string;
  lead_time: number | null;
  safety_days: string | null;
  target_cover_days: string | null;
  min_qty: string | null;
  max_qty: string | null;
  pack_base: string | null;
  moq_base: string | null;
};

// The reorder rule from the design: status, the level that triggers it, and the suggested order
// rounded up to the preferred supplier's pack size and minimum order.
export function reorderDecision(i: ReorderInput): { status: ReorderStatus; reorder_at: string | null; target: string | null; suggest: string | null } {
  const onHand = dec(i.on_hand);
  const position = add(onHand, dec(i.on_order));
  const daily = dec(i.daily_usage);
  let reorderAt: Dec;
  let target: Dec;
  let critical: boolean;
  if (i.method === 'min_max') {
    reorderAt = dec(i.min_qty ?? '0');
    target = dec(i.max_qty ?? '0');
    critical = onHand <= 0n || cmp(onHand, div(reorderAt, dec('2'))) < 0;
  } else {
    if (i.lead_time === null) return { status: 'needs_lead_time', reorder_at: null, target: null, suggest: null };
    if (daily === 0n) return { status: 'needs_usage_history', reorder_at: null, target: null, suggest: null };
    reorderAt = mul(daily, add(dec(String(i.lead_time)), dec(i.safety_days ?? '0')));
    target = mul(daily, dec(i.target_cover_days ?? '0'));
    critical = cmp(onHand, mul(daily, dec(i.safety_days ?? '0'))) < 0;
  }
  const status: ReorderStatus = critical ? 'critical' : cmp(position, reorderAt) <= 0 ? 'reorder' : 'ok';
  let suggest: Dec | null = null;
  if (status !== 'ok') {
    let need = sub(target, position);
    if (need < 0n) need = 0n;
    if (i.pack_base) need = times(dec(i.pack_base), ceilCount(need, dec(i.pack_base)));
    if (i.moq_base && cmp(need, dec(i.moq_base)) < 0) need = dec(i.moq_base);
    if (i.pack_base && need % dec(i.pack_base) !== 0n) need = times(dec(i.pack_base), ceilCount(need, dec(i.pack_base)));
    suggest = need;
  }
  return { status, reorder_at: str(reorderAt), target: str(target), suggest: suggest === null ? null : str(suggest) };
}

export default defineOp({
  name: 'low_stock_report',
  summary:
    'What needs ordering: for every item with a reorder policy, usable on-hand (released, not quarantined), on order, daily usage from the ledger, days of cover, lead time, status (critical, reorder, ok, needs_lead_time, needs_usage_history) and a suggested order rounded to the preferred supplier\'s pack and MOQ. Also lots expiring soon.',
  kind: 'read',
  scope: 'read',
  input: z
    .object({
      site_code: siteCode.optional(),
      include_ok: z.boolean().default(false),
      expiring_within_days: z.number().int().min(1).max(365).default(30),
    })
    .strict(),
  async handler(args, tx) {
    const rows = (
      await tx.query(
        `SELECT p.item_id, i.sku, i.name, i.base_uom, s.code AS site_code, p.site_id, p.method,
                p.min_qty_base::text AS min_qty, p.max_qty_base::text AS max_qty, p.safety_days::text AS safety_days,
                p.target_cover_days::text AS target_cover_days, p.usage_window_days,
                coalesce((SELECT sum(b.qty_base) FROM stock_balance b JOIN location l ON l.id = b.location_id
                           LEFT JOIN lot lt ON lt.id = b.lot_id
                          WHERE b.item_id = p.item_id AND l.site_id = p.site_id AND l.kind <> 'quarantine'
                            AND (lt.id IS NULL OR lt.status = 'released')), 0)::text AS on_hand,
                coalesce((SELECT sum(pl.qty_base - pl.received_qty_base) FROM po_line pl JOIN purchase_order po ON po.id = pl.po_id
                          WHERE pl.item_id = p.item_id AND po.site_id = p.site_id
                            AND po.status IN ('approved','sent','acknowledged','partially_received')), 0)::text AS on_order,
                coalesce((SELECT -sum(t.qty_base) FROM stock_txn t JOIN location l ON l.id = t.location_id
                          WHERE t.item_id = p.item_id AND l.site_id = p.site_id
                            AND t.txn_type IN ('issue','production_consume','scrap')
                            AND t.occurred_at >= now() - make_interval(days => p.usage_window_days)), 0)::text AS used,
                coalesce(p.lead_time_override, si.lead_time_days) AS lead_time,
                si.supplier_id AS preferred_supplier_id, sup.name AS preferred_supplier,
                pk.base_qty::text AS pack_base, pk.name AS purchase_pack, si.moq_base::text AS moq_base
           FROM reorder_policy p
           JOIN item i ON i.id = p.item_id
           JOIN site s ON s.id = p.site_id
           LEFT JOIN supplier_item si ON si.item_id = p.item_id AND si.is_preferred
           LEFT JOIN supplier sup ON sup.id = si.supplier_id
           LEFT JOIN item_pack pk ON pk.id = si.purchase_pack_id
          WHERE p.method <> 'manual' AND i.status = 'active' AND ($1::text IS NULL OR s.code = $1)
          ORDER BY i.sku, s.code`,
        [args.site_code ?? null],
      )
    ).rows;
    const packs = await packsByItem(tx, [...new Set(rows.map((r) => r.item_id as string))]);
    const items = [];
    for (const r of rows) {
      const daily = str(div(dec(r.used), dec(String(r.usage_window_days))));
      const decision = reorderDecision({
        method: r.method, on_hand: r.on_hand, on_order: r.on_order, daily_usage: daily, lead_time: r.lead_time,
        safety_days: r.safety_days, target_cover_days: r.target_cover_days, min_qty: r.min_qty, max_qty: r.max_qty,
        pack_base: r.pack_base, moq_base: r.moq_base,
      });
      if (decision.status === 'ok' && !args.include_ok) continue;
      const itemPacks = packs.get(r.item_id) ?? [];
      items.push({
        item_id: r.item_id, sku: r.sku, name: r.name, site_code: r.site_code, base_uom: r.base_uom, method: r.method,
        status: decision.status, on_hand: str(dec(r.on_hand)), on_order: str(dec(r.on_order)), daily_usage: daily,
        cover_days: dec(daily) === 0n ? null : str(div(dec(r.on_hand), dec(daily)), 1),
        lead_time_days: r.lead_time, reorder_at: decision.reorder_at, target: decision.target,
        suggest_qty_base: decision.suggest,
        suggest_display: decision.suggest ? describeInPacks(decision.suggest, itemPacks, r.base_uom) : null,
        preferred_supplier_id: r.preferred_supplier_id, preferred_supplier: r.preferred_supplier, purchase_pack: r.purchase_pack,
      });
    }
    const order: Record<ReorderStatus, number> = { critical: 0, reorder: 1, needs_lead_time: 2, needs_usage_history: 3, ok: 4 };
    items.sort((a, b) => order[a.status] - order[b.status]);
    const expiring = await tx.query(
      `SELECT i.sku, lt.lot_code, lt.expires_on, s.code AS site_code, sum(b.qty_base)::text AS qty_base, i.base_uom
         FROM stock_balance b JOIN lot lt ON lt.id = b.lot_id JOIN item i ON i.id = b.item_id
         JOIN location l ON l.id = b.location_id JOIN site s ON s.id = l.site_id
        WHERE b.qty_base > 0 AND lt.expires_on IS NOT NULL AND lt.expires_on <= current_date + $1::int
          AND ($2::text IS NULL OR s.code = $2)
        GROUP BY i.sku, lt.lot_code, lt.expires_on, s.code, i.base_uom ORDER BY lt.expires_on`,
      [args.expiring_within_days, args.site_code ?? null],
    );
    return { items, expiring_lots: expiring.rows };
  },
});
