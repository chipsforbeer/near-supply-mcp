import { z } from 'zod';
import { defineOp } from '../define.ts';
import { viaAgent } from '../types.ts';
import { requireItem, requireLocation } from './common.ts';
import { balanceOf, packIdFor, postTxn, resolveLot } from './ledger.ts';
import { locationCode, nonNegativeDecimal, siteCode, unitFields } from '../schemas.ts';
import { loadItemUnits, toBase } from '../../domain/units.ts';
import { dec, str, sub } from '../../domain/decimal.ts';

export default defineOp({
  name: 'stock_count',
  summary:
    'Record a physical count ("two full jerrycans and one half full" = 62.5 L). Writes only the difference from the system figure as a count correction; a matching count writes nothing.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      item_id: z.uuid(),
      site_code: siteCode,
      location_code: locationCode,
      lot_code: z.string().trim().min(1).max(80).optional(),
      counted_qty: nonNegativeDecimal,
      ...unitFields,
      note: z.string().max(1000).optional(),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const item = await requireItem(tx, args.item_id);
    const units = await loadItemUnits(tx, item.id);
    const counted = toBase(args.counted_qty, { uom: args.uom, pack: args.pack }, units);
    const loc = await requireLocation(tx, args.site_code, args.location_code);
    const lot = await resolveLot(tx, item, args.lot_code, dec(counted) > 0n ? { status: loc.kind === 'quarantine' ? 'quarantine' : 'released' } : undefined);
    const previous = await balanceOf(tx, item.id, loc.id, lot?.id ?? null, true);
    const diff = sub(dec(counted), dec(previous));
    if (diff === 0n) {
      return { counted_base: counted, previous_base: str(dec(previous)), correction_base: '0', txn_id: null, base_uom: units.baseUom };
    }
    const posted = await postTxn(tx, {
      item_id: item.id,
      location_id: loc.id,
      lot_id: lot?.id ?? null,
      txn_type: 'count_correction',
      qty_base: str(diff),
      counted_qty_base: counted,
      entered_qty: args.counted_qty,
      entered_pack_id: await packIdFor(tx, item.id, args.pack),
      entered_uom: args.pack ? null : (args.uom ?? units.baseUom),
      reference_type: 'count',
      note: args.note ?? null,
      actor_user_id: ctx.session.userId,
      via_agent: viaAgent(ctx.session),
    });
    return {
      counted_base: counted,
      previous_base: str(dec(previous)),
      correction_base: str(diff),
      txn_id: posted.txn_id,
      base_uom: units.baseUom,
    };
  },
});
