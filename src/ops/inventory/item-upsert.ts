import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { brandIdFor, CATEGORIES, ITEM_STATUSES, PHYSICAL_FORMS, requireUom, SOURCING_TYPES } from './common.ts';
import { uomCode } from '../schemas.ts';

export default defineOp({
  name: 'item_upsert',
  summary:
    'Create an item, or update it by SKU (fields you leave out keep their values). base_uom is the unit stock is counted in and cannot change later.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      sku: z.string().trim().min(1).max(80),
      name: z.string().trim().min(1).max(200).optional(),
      category: z.enum(CATEGORIES).optional(),
      physical_form: z.enum(PHYSICAL_FORMS).optional(),
      sourcing_type: z.enum(SOURCING_TYPES).optional(),
      base_uom: uomCode.optional(),
      is_lot_tracked: z.boolean().optional(),
      shelf_life_days: z.number().int().positive().nullable().optional(),
      hazmat_class: z.string().max(80).nullable().optional(),
      storage_notes: z.string().max(500).nullable().optional(),
      attributes: z.record(z.string(), z.unknown()).optional(),
      brand: z.string().trim().min(1).max(120).nullable().optional(),
      status: z.enum(ITEM_STATUSES).optional(),
    })
    .strict(),
  async handler(args, tx) {
    const existing = (await tx.query('SELECT id, base_uom FROM item WHERE sku = $1 FOR UPDATE', [args.sku])).rows[0];
    if (args.base_uom) await requireUom(tx, args.base_uom);
    const brandId = args.brand === undefined ? undefined : await brandIdFor(tx, args.brand ?? undefined);

    if (!existing) {
      const missing = (['name', 'category', 'physical_form', 'sourcing_type', 'base_uom'] as const).filter((k) => args[k] === undefined);
      if (missing.length) throw new OpError('invalid_arguments', `New items need: ${missing.join(', ')}.`);
      const r = await tx.query(
        `INSERT INTO item (sku, name, category, physical_form, sourcing_type, base_uom, is_lot_tracked,
                           shelf_life_days, hazmat_class, storage_notes, attributes, brand_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, coalesce($7, false), $8, $9, $10, coalesce($11, '{}'::jsonb), $12, coalesce($13, 'active'))
         RETURNING *`,
        [args.sku, args.name, args.category, args.physical_form, args.sourcing_type, args.base_uom, args.is_lot_tracked ?? null,
          args.shelf_life_days ?? null, args.hazmat_class ?? null, args.storage_notes ?? null,
          args.attributes ? JSON.stringify(args.attributes) : null, brandId ?? null, args.status ?? null],
      );
      return { created: true, item: r.rows[0] };
    }

    if (args.base_uom && args.base_uom !== existing.base_uom) {
      throw new OpError('invalid_arguments', `base_uom is ${existing.base_uom} and cannot change after the item is created.`);
    }
    const keep = (v: unknown) => (v === undefined ? null : v);
    const r = await tx.query(
      `UPDATE item SET
          name = coalesce($2, name),
          category = coalesce($3, category),
          physical_form = coalesce($4, physical_form),
          sourcing_type = coalesce($5, sourcing_type),
          is_lot_tracked = coalesce($6, is_lot_tracked),
          shelf_life_days = CASE WHEN $7::boolean THEN $8::int ELSE shelf_life_days END,
          hazmat_class = CASE WHEN $9::boolean THEN $10 ELSE hazmat_class END,
          storage_notes = CASE WHEN $11::boolean THEN $12 ELSE storage_notes END,
          attributes = coalesce($13::jsonb, attributes),
          brand_id = CASE WHEN $14::boolean THEN $15::uuid ELSE brand_id END,
          status = coalesce($16, status),
          updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [existing.id, keep(args.name), keep(args.category), keep(args.physical_form), keep(args.sourcing_type), keep(args.is_lot_tracked),
        args.shelf_life_days !== undefined, args.shelf_life_days ?? null,
        args.hazmat_class !== undefined, args.hazmat_class ?? null,
        args.storage_notes !== undefined, args.storage_notes ?? null,
        args.attributes ? JSON.stringify(args.attributes) : null,
        brandId !== undefined, brandId ?? null, keep(args.status)],
    );
    return { created: false, item: r.rows[0] };
  },
});
