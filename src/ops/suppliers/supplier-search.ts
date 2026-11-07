import { z } from 'zod';
import { defineOp } from '../define.ts';
import { SUPPLIER_STATUSES } from './common.ts';
import { limit } from '../schemas.ts';

// An active offering's words: category, description and tags.
const OFFERING_MATCH = `o.status = 'active'
  AND to_tsvector('simple', o.category || ' ' || coalesce(o.description, '') || ' ' || array_to_string(o.tags, ' '))
      @@ websearch_to_tsquery('simple', $8)`;

export default defineOp({
  name: 'supplier_search',
  summary:
    'Find suppliers by name text, capability (laser_cutting, cnc...), an item they sell us, what they offer (words in their ' +
    'active offerings, such as "laser cutting" or "316 sheet"), status, origin or country.',
  kind: 'read',
  scope: 'read',
  input: z
    .object({
      query: z.string().trim().min(1).max(120).optional(),
      capability: z.string().trim().min(1).max(60).optional(),
      item_id: z.uuid().optional(),
      offering: z.string().trim().min(1).max(200).optional(),
      status: z.enum(SUPPLIER_STATUSES).optional(),
      origin: z.enum(['existing', 'discovered']).optional(),
      country_code: z.string().regex(/^[A-Z]{2}$/).optional(),
      limit: limit(100, 25),
    })
    .strict(),
  async handler(args, tx) {
    const r = await tx.query(
      `SELECT s.id, s.name, s.status, s.origin, s.supplier_type, s.capabilities, s.country_code, s.email_domain,
              s.last_contacted_at, s.last_reply_at,
              si.lead_time_days, si.last_price, si.last_price_per, si.last_price_currency, si.is_preferred,
              CASE WHEN $8::text IS NULL THEN NULL ELSE
                (SELECT array_agg(o.category ORDER BY o.category) FROM supplier_offering o WHERE o.supplier_id = s.id AND ${OFFERING_MATCH})
              END AS matched_offerings
         FROM supplier s
         LEFT JOIN supplier_item si ON si.supplier_id = s.id AND si.item_id = $3
        WHERE ($1::text IS NULL OR s.name ILIKE '%' || $1 || '%' OR s.legal_name ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR $2 = ANY (s.capabilities))
          AND ($3::uuid IS NULL OR si.id IS NOT NULL)
          AND ($4::text IS NULL OR s.status = $4)
          AND ($5::text IS NULL OR s.origin = $5)
          AND ($6::text IS NULL OR s.country_code = $6)
          AND ($8::text IS NULL OR EXISTS (SELECT 1 FROM supplier_offering o WHERE o.supplier_id = s.id AND ${OFFERING_MATCH}))
        ORDER BY si.is_preferred DESC NULLS LAST, s.status = 'preferred' DESC, s.name
        LIMIT $7`,
      [args.query ?? null, args.capability ?? null, args.item_id ?? null, args.status ?? null, args.origin ?? null,
        args.country_code ?? null, args.limit, args.offering ?? null],
    );
    return { items: r.rows };
  },
});
