import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { CONTAINER_KINDS, requireItem } from './common.ts';
import { positiveDecimal } from '../schemas.ts';
import { dec, mul, str } from '../../domain/decimal.ts';

export default defineOp({
  name: 'item_pack_upsert',
  summary:
    'Define how an item is packed: "25 kg sack" holds 25 base units; "pallet" contains 40 of the "25 kg sack" pack. Packs can nest. Upsert by name.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      item_id: z.uuid(),
      name: z.string().trim().min(1).max(120),
      contains_qty: positiveDecimal,
      contains_pack: z.string().trim().min(1).max(120).optional(),
      container_kind: z.enum(CONTAINER_KINDS).optional(),
      container_name: z.string().trim().min(1).max(120).optional(),
      barcode: z.string().trim().max(64).optional(),
      is_default_receive: z.boolean().optional(),
      is_default_issue: z.boolean().optional(),
    })
    .strict(),
  async handler(args, tx) {
    await requireItem(tx, args.item_id);

    let containsPackId: string | null = null;
    let baseQty = dec(args.contains_qty);
    if (args.contains_pack) {
      const inner = await tx.query(
        'SELECT id, base_qty::text AS base_qty FROM item_pack WHERE item_id = $1 AND (lower(name) = lower($2) OR id::text = $2)',
        [args.item_id, args.contains_pack],
      );
      if (!inner.rows[0]) throw new OpError('not_found', `No pack "${args.contains_pack}" on this item; define it first.`);
      if (args.contains_pack.toLowerCase() === args.name.toLowerCase()) throw new OpError('invalid_arguments', 'A pack cannot contain itself.');
      containsPackId = inner.rows[0].id;
      baseQty = mul(baseQty, dec(inner.rows[0].base_qty));
    }

    let containerTypeId: string | null = null;
    if (args.container_name) {
      const c = await tx.query('SELECT id FROM container_type WHERE lower(name) = lower($1) ORDER BY company_id NULLS LAST LIMIT 1', [args.container_name]);
      if (c.rows[0]) containerTypeId = c.rows[0].id;
      else if (args.container_kind) {
        const created = await tx.query('INSERT INTO container_type (kind, name) VALUES ($1, $2) RETURNING id', [args.container_kind, args.container_name]);
        containerTypeId = created.rows[0].id;
      } else {
        throw new OpError('invalid_arguments', `Unknown container "${args.container_name}"; also give container_kind to create it.`);
      }
    } else if (args.container_kind) {
      const c = await tx.query(
        'SELECT id FROM container_type WHERE company_id IS NULL AND kind = $1 ORDER BY nominal_capacity NULLS FIRST LIMIT 1',
        [args.container_kind],
      );
      containerTypeId = c.rows[0]?.id ?? null;
    }

    if (args.is_default_receive) await tx.query('UPDATE item_pack SET is_default_receive = false WHERE item_id = $1', [args.item_id]);
    if (args.is_default_issue) await tx.query('UPDATE item_pack SET is_default_issue = false WHERE item_id = $1', [args.item_id]);

    const r = await tx.query(
      `INSERT INTO item_pack (item_id, name, container_type_id, contains_pack_id, contains_qty, base_qty, barcode,
                              is_default_receive, is_default_issue)
       VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, false), coalesce($9, false))
       ON CONFLICT (company_id, item_id, name) DO UPDATE
         SET container_type_id = EXCLUDED.container_type_id, contains_pack_id = EXCLUDED.contains_pack_id,
             contains_qty = EXCLUDED.contains_qty, base_qty = EXCLUDED.base_qty, barcode = EXCLUDED.barcode,
             is_default_receive = EXCLUDED.is_default_receive, is_default_issue = EXCLUDED.is_default_issue
       RETURNING id, item_id, name, contains_qty, base_qty, barcode, is_default_receive, is_default_issue`,
      [args.item_id, args.name, containerTypeId, containsPackId, args.contains_qty, str(baseQty), args.barcode ?? null,
        args.is_default_receive ?? null, args.is_default_issue ?? null],
    );
    return r.rows[0];
  },
});
