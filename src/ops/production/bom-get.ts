import type pg from 'pg';
import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';

export async function loadBom(tx: pg.PoolClient, outputItemId: string, version?: number) {
  const b = await tx.query(
    `SELECT id, output_item_id, version, status, batch_qty_base::text AS batch_qty_base, expected_yield, notes, created_at
       FROM bom WHERE output_item_id = $1 AND (($2::int IS NULL AND status = 'active') OR version = $2)`,
    [outputItemId, version ?? null],
  );
  const bom = b.rows[0];
  if (!bom) throw new OpError('not_found', version ? `No BOM version ${version} for this item.` : 'This item has no active BOM.');
  const lines = await tx.query(
    `SELECT l.line_no, l.item_id, i.sku, i.name, i.base_uom, i.is_lot_tracked, l.qty_base::text AS qty_base,
            l.scrap_factor::text AS scrap_factor, l.scales_with_batch
       FROM bom_line l JOIN item i ON i.id = l.item_id
      WHERE l.bom_id = $1 ORDER BY l.line_no`,
    [bom.id],
  );
  return { ...bom, lines: lines.rows };
}

export default defineOp({
  name: 'bom_get',
  summary: 'The active (or a given version of the) bill of materials for an output item, with each component per batch.',
  kind: 'read',
  scope: 'read',
  input: z.object({ output_item_id: z.uuid(), version: z.number().int().positive().optional() }).strict(),
  async handler(args, tx) {
    return loadBom(tx, args.output_item_id, args.version);
  },
});
