import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { describeInPacks } from '../../domain/units.ts';
import { sequential } from '../../db/pool.ts';

export default defineOp({
  name: 'item_get',
  summary: 'One item by item_id or sku: details, packs, identifiers (MPN, CAS, drawing...), unit conversions.',
  kind: 'read',
  scope: 'read',
  input: z
    .object({ item_id: z.uuid().optional(), sku: z.string().trim().min(1).max(80).optional() })
    .strict()
    .refine((v) => (v.item_id === undefined) !== (v.sku === undefined), { message: 'Give item_id or sku.' }),
  async handler(args, tx) {
    const r = await tx.query(
      `SELECT i.*, b.name AS brand FROM item i LEFT JOIN brand b ON b.id = i.brand_id
        WHERE ($1::uuid IS NOT NULL AND i.id = $1) OR ($2::text IS NOT NULL AND i.sku = $2)`,
      [args.item_id ?? null, args.sku ?? null],
    );
    const item = r.rows[0];
    if (!item) throw new OpError('not_found', 'Item not found.');
    const [packs, identifiers, conversions, stock] = await sequential([
      () => tx.query(
        `SELECT p.id, p.name, p.contains_qty, p.base_qty, p.barcode, p.is_default_receive, p.is_default_issue,
                c.kind AS container_kind, c.name AS container_name, inner_p.name AS contains_pack
           FROM item_pack p
           LEFT JOIN container_type c ON c.id = p.container_type_id
           LEFT JOIN item_pack inner_p ON inner_p.id = p.contains_pack_id
          WHERE p.item_id = $1 ORDER BY p.base_qty`,
        [item.id],
      ),
      () => tx.query(
        `SELECT id, kind, value, manufacturer, revision, document_id, is_primary
           FROM item_identifier WHERE item_id = $1 ORDER BY is_primary DESC, kind, value`,
        [item.id],
      ),
      () => tx.query('SELECT from_uom, to_uom, factor FROM item_uom_conversion WHERE item_id = $1', [item.id]),
      () => tx.query(
        `SELECT s.code AS site_code, sum(b.qty_base)::text AS qty_base
           FROM stock_balance b JOIN location l ON l.id = b.location_id JOIN site s ON s.id = l.site_id
          WHERE b.item_id = $1 GROUP BY s.code ORDER BY s.code`,
        [item.id],
      ),
    ]);
    const packInfo = packs.rows.map((p) => ({ id: p.id, name: p.name, baseQty: String(p.base_qty) }));
    const { brand_id: _b, company_id: _c, ...rest } = item;
    return {
      ...rest,
      packs: packs.rows,
      identifiers: identifiers.rows,
      conversions: conversions.rows,
      stock: stock.rows.map((s) => ({ ...s, display: describeInPacks(s.qty_base, packInfo, item.base_uom) })),
    };
  },
});
