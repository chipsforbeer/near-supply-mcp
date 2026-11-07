import type pg from 'pg';
import { z } from 'zod';
import { defineOp } from '../define.ts';
import { limit, siteCode } from '../schemas.ts';
import { describeInPacks, type PackInfo } from '../../domain/units.ts';

export async function packsByItem(tx: pg.PoolClient, itemIds: string[]): Promise<Map<string, PackInfo[]>> {
  const map = new Map<string, PackInfo[]>();
  if (!itemIds.length) return map;
  const r = await tx.query('SELECT item_id, id, name, base_qty::text AS base_qty FROM item_pack WHERE item_id = ANY($1)', [itemIds]);
  for (const row of r.rows) {
    const list = map.get(row.item_id) ?? [];
    list.push({ id: row.id, name: row.name, baseQty: row.base_qty });
    map.set(row.item_id, list);
  }
  return map;
}

export default defineOp({
  name: 'stock_levels',
  summary: 'Current stock by item, site, location and lot, with lot status (quarantined lots are not usable) and a pack-based display.',
  kind: 'read',
  scope: 'read',
  input: z
    .object({
      item_id: z.uuid().optional(),
      site_code: siteCode.optional(),
      include_zero: z.boolean().default(false),
      limit: limit(500, 200),
    })
    .strict(),
  async handler(args, tx) {
    const r = await tx.query(
      `SELECT b.item_id, i.sku, i.name, i.base_uom, s.code AS site_code, l.code AS location_code, l.kind AS location_kind,
              lt.lot_code, lt.status AS lot_status, lt.expires_on, b.qty_base::text AS qty_base, b.updated_at
         FROM stock_balance b
         JOIN item i ON i.id = b.item_id
         JOIN location l ON l.id = b.location_id
         JOIN site s ON s.id = l.site_id
         LEFT JOIN lot lt ON lt.id = b.lot_id
        WHERE ($1::uuid IS NULL OR b.item_id = $1)
          AND ($2::text IS NULL OR s.code = $2)
          AND ($3::boolean OR b.qty_base <> 0)
        ORDER BY i.sku, s.code, l.code, lt.lot_code NULLS FIRST
        LIMIT $4`,
      [args.item_id ?? null, args.site_code ?? null, args.include_zero, args.limit],
    );
    const packs = await packsByItem(tx, [...new Set(r.rows.map((x) => x.item_id as string))]);
    return {
      items: r.rows.map((row) => ({
        ...row,
        usable: row.location_kind !== 'quarantine' && (row.lot_status === null || row.lot_status === 'released'),
        display: describeInPacks(row.qty_base, packs.get(row.item_id) ?? [], row.base_uom),
      })),
    };
  },
});
