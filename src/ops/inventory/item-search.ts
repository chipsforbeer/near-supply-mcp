import { z } from 'zod';
import { defineOp } from '../define.ts';
import { CATEGORIES, ITEM_STATUSES, SOURCING_TYPES } from './common.ts';
import { limit } from '../schemas.ts';

export default defineOp({
  name: 'item_search',
  summary: 'Find items by name or SKU text, by an exact identifier (MPN, CAS number, drawing number...), or by category.',
  kind: 'read',
  scope: 'read',
  input: z
    .object({
      query: z.string().trim().min(1).max(120).optional(),
      identifier: z.string().trim().min(1).max(120).optional(),
      category: z.enum(CATEGORIES).optional(),
      sourcing_type: z.enum(SOURCING_TYPES).optional(),
      status: z.enum(ITEM_STATUSES).optional(),
      limit: limit(100, 25),
    })
    .strict(),
  async handler(args, tx) {
    const r = await tx.query(
      `SELECT i.id, i.sku, i.name, i.category, i.sourcing_type, i.base_uom, i.status,
              (SELECT json_agg(json_build_object('kind', x.kind, 'value', x.value, 'manufacturer', x.manufacturer))
                 FROM item_identifier x WHERE x.item_id = i.id) AS identifiers
         FROM item i
        WHERE ($1::text IS NULL OR i.name ILIKE '%' || $1 || '%' OR i.sku ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM item_identifier x WHERE x.item_id = i.id AND lower(x.value) = lower($2)))
          AND ($3::text IS NULL OR i.category = $3)
          AND ($4::text IS NULL OR i.sourcing_type = $4)
          AND ($5::text IS NULL OR i.status = $5)
        ORDER BY i.name
        LIMIT $6`,
      [args.query ?? null, args.identifier ?? null, args.category ?? null, args.sourcing_type ?? null, args.status ?? null, args.limit],
    );
    return { items: r.rows };
  },
});
