import { z } from 'zod';
import { defineOp } from '../define.ts';
import { requireItem } from './common.ts';
import { isoDateTime, limit } from '../schemas.ts';

export default defineOp({
  name: 'stock_history',
  summary: 'Ledger rows for one item, newest first: what moved, how it was entered ("3 drums"), who recorded it, and why.',
  kind: 'read',
  scope: 'read',
  input: z.object({ item_id: z.uuid(), since: isoDateTime.optional(), limit: limit(500, 100) }).strict(),
  async handler(args, tx) {
    await requireItem(tx, args.item_id);
    const r = await tx.query(
      `SELECT t.id AS txn_id, t.txn_type, t.qty_base::text AS qty_base, t.entered_qty, p.name AS entered_pack, t.entered_uom,
              t.counted_qty_base, s.code AS site_code, l.code AS location_code, lt.lot_code, t.reference_type, t.reference_id,
              t.reverses_txn_id, t.note, t.occurred_at, t.recorded_at, u.email AS recorded_by, t.via_agent
         FROM stock_txn t
         JOIN location l ON l.id = t.location_id
         JOIN site s ON s.id = l.site_id
         LEFT JOIN lot lt ON lt.id = t.lot_id
         LEFT JOIN item_pack p ON p.id = t.entered_pack_id
         JOIN app_user u ON u.id = t.actor_user_id
        WHERE t.item_id = $1 AND ($2::timestamptz IS NULL OR t.occurred_at >= $2)
        ORDER BY t.occurred_at DESC, t.id DESC
        LIMIT $3`,
      [args.item_id, args.since ?? null, args.limit],
    );
    return { txns: r.rows };
  },
});
