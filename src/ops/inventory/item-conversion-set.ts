import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { requireItem, requireUom } from './common.ts';
import { positiveDecimal, uomCode } from '../schemas.ts';

export default defineOp({
  name: 'item_conversion_set',
  summary:
    'Item-specific conversion between dimensions, for example caustic soda 1 L = 1.52 kg, or wire 1 kg = 45 m. Needed before entering a quantity in a unit of another dimension.',
  kind: 'write',
  scope: 'write',
  input: z.object({ item_id: z.uuid(), from_uom: uomCode, to_uom: uomCode, factor: positiveDecimal }).strict(),
  async handler(args, tx) {
    await requireItem(tx, args.item_id);
    const from = await requireUom(tx, args.from_uom);
    const to = await requireUom(tx, args.to_uom);
    if (from.dimension === to.dimension) {
      throw new OpError('invalid_arguments', `${args.from_uom} and ${args.to_uom} are both ${from.dimension}; that conversion is built in.`);
    }
    const r = await tx.query(
      `INSERT INTO item_uom_conversion (item_id, from_uom, to_uom, factor) VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, item_id, from_uom, to_uom) DO UPDATE SET factor = EXCLUDED.factor
       RETURNING item_id, from_uom, to_uom, factor`,
      [args.item_id, args.from_uom, args.to_uom, args.factor],
    );
    return r.rows[0];
  },
});
