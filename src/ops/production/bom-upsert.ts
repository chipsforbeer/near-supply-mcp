import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { requireItem } from '../inventory/common.ts';
import { positiveDecimal, unitFields } from '../schemas.ts';
import { loadItemUnits, toBase } from '../../domain/units.ts';

export default defineOp({
  name: 'bom_upsert',
  summary:
    'Save a new version of the bill of materials (recipe) for an output item: what one batch of batch_qty consumes. scrap_factor 0.12 adds 12% (offcuts, process loss). The new active version retires the old one.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      output_item_id: z.uuid(),
      batch_qty: positiveDecimal,
      batch_uom: unitFields.uom,
      batch_pack: unitFields.pack,
      expected_yield: z.number().gt(0).max(1).optional(),
      notes: z.string().max(2000).optional(),
      status: z.enum(['active', 'draft']).default('active'),
      lines: z
        .array(
          z
            .object({
              item_id: z.uuid(),
              qty: positiveDecimal,
              ...unitFields,
              scrap_factor: z.number().min(0).lt(10).optional(),
              scales_with_batch: z.boolean().optional(),
            })
            .strict(),
        )
        .min(1)
        .max(200),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const output = await requireItem(tx, args.output_item_id);
    const batchQty = toBase(args.batch_qty, { uom: args.batch_uom, pack: args.batch_pack }, await loadItemUnits(tx, output.id));
    const seen = new Set<string>();
    const lines = [];
    for (const line of args.lines) {
      if (line.item_id === output.id) throw new OpError('invalid_arguments', 'An item cannot be a component of itself.');
      if (seen.has(line.item_id)) throw new OpError('invalid_arguments', 'Each component may appear once; combine the quantities.');
      seen.add(line.item_id);
      const component = await requireItem(tx, line.item_id);
      lines.push({
        item_id: component.id,
        qty_base: toBase(line.qty, { uom: line.uom, pack: line.pack }, await loadItemUnits(tx, component.id)),
        scrap_factor: line.scrap_factor ?? 0,
        scales_with_batch: line.scales_with_batch ?? true,
      });
    }
    const v = await tx.query('SELECT coalesce(max(version), 0) + 1 AS next FROM bom WHERE output_item_id = $1', [output.id]);
    const version = v.rows[0].next as number;
    if (args.status === 'active') {
      await tx.query(`UPDATE bom SET status = 'retired' WHERE output_item_id = $1 AND status = 'active'`, [output.id]);
    }
    const bom = await tx.query(
      `INSERT INTO bom (output_item_id, version, status, batch_qty_base, expected_yield, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, version, status, batch_qty_base`,
      [output.id, version, args.status, batchQty, args.expected_yield ?? null, args.notes ?? null, ctx.session.userId],
    );
    let n = 0;
    for (const line of lines) {
      n += 1;
      await tx.query(
        `INSERT INTO bom_line (bom_id, line_no, item_id, qty_base, scrap_factor, scales_with_batch)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [bom.rows[0].id, n, line.item_id, line.qty_base, line.scrap_factor, line.scales_with_batch],
      );
    }
    return { bom_id: bom.rows[0].id, output_sku: output.sku, ...bom.rows[0], lines: lines.length };
  },
});
