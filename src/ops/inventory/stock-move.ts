import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { viaAgent } from '../types.ts';
import { requireItem, requireLocation } from './common.ts';
import { packIdFor, postTxn, resolveLot, type TxnType } from './ledger.ts';
import { isoDate, isoDateTime, locationCode, positiveDecimal, siteCode, unitFields } from '../schemas.ts';
import { loadItemUnits, toBase } from '../../domain/units.ts';
import { dec, neg, str } from '../../domain/decimal.ts';

const SIGN: Record<string, { type: TxnType; up: boolean }> = {
  receipt: { type: 'receipt', up: true },
  opening_balance: { type: 'opening_balance', up: true },
  issue: { type: 'issue', up: false },
  scrap: { type: 'scrap', up: false },
  sample: { type: 'sample', up: false },
  return_to_supplier: { type: 'return_to_supplier', up: false },
};

export default defineOp({
  name: 'stock_move',
  summary:
    'Record stock going in or out: receipt, opening_balance, issue (ad hoc use), scrap, sample, return_to_supplier, or transfer between locations at a site. Quantity in any unit or pack ("3" + pack "200 L drum"). Production use goes through production_run_record; purchase receipts through po_receive.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      item_id: z.uuid(),
      type: z.enum(['receipt', 'opening_balance', 'issue', 'scrap', 'sample', 'return_to_supplier', 'transfer']),
      qty: positiveDecimal,
      ...unitFields,
      site_code: siteCode,
      location_code: locationCode,
      to_location_code: locationCode.optional(),
      lot_code: z.string().trim().min(1).max(80).optional(),
      expires_on: isoDate.optional(),
      manufactured_on: isoDate.optional(),
      note: z.string().max(1000).optional(),
      occurred_at: isoDateTime.optional(),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const item = await requireItem(tx, args.item_id);
    const units = await loadItemUnits(tx, item.id);
    const qtyBase = toBase(args.qty, { uom: args.uom, pack: args.pack }, units);
    const from = await requireLocation(tx, args.site_code, args.location_code);
    const packId = await packIdFor(tx, item.id, args.pack);
    const actor = { actor_user_id: ctx.session.userId, via_agent: viaAgent(ctx.session) };
    const entered = { entered_qty: args.qty, entered_pack_id: packId, entered_uom: args.pack ? null : (args.uom ?? units.baseUom) };
    const common = { item_id: item.id, note: args.note ?? null, occurred_at: args.occurred_at ?? null, ...entered, ...actor };

    if (args.type === 'transfer') {
      if (!args.to_location_code) throw new OpError('invalid_arguments', 'Transfers need to_location_code.');
      if (args.to_location_code === args.location_code) throw new OpError('invalid_arguments', 'Transfer to a different location.');
      const to = await requireLocation(tx, args.site_code, args.to_location_code);
      const lot = await resolveLot(tx, item, args.lot_code);
      const ref = randomUUID();
      const out = await postTxn(tx, { ...common, location_id: from.id, lot_id: lot?.id ?? null, txn_type: 'transfer_out', qty_base: str(neg(dec(qtyBase))), reference_type: 'transfer', reference_id: ref });
      const inn = await postTxn(tx, { ...common, location_id: to.id, lot_id: lot?.id ?? null, txn_type: 'transfer_in', qty_base: qtyBase, reference_type: 'transfer', reference_id: ref });
      return {
        qty_base: qtyBase,
        base_uom: units.baseUom,
        txns: [
          { txn_id: out.txn_id, txn_type: 'transfer_out', location_code: from.code, balance_after: out.balance_after },
          { txn_id: inn.txn_id, txn_type: 'transfer_in', location_code: to.code, balance_after: inn.balance_after },
        ],
      };
    }

    if (args.to_location_code) throw new OpError('invalid_arguments', 'to_location_code is only for transfers.');
    const sign = SIGN[args.type]!;
    const lot = await resolveLot(
      tx,
      item,
      args.lot_code,
      sign.up
        ? {
            status: from.kind === 'quarantine' ? 'quarantine' : 'released',
            expires_on: args.expires_on ?? null,
            manufactured_on: args.manufactured_on ?? null,
            received_on: sign.type === 'receipt' ? (args.occurred_at ?? new Date().toISOString()).slice(0, 10) : null,
          }
        : undefined,
    );
    const posted = await postTxn(tx, {
      ...common,
      location_id: from.id,
      lot_id: lot?.id ?? null,
      txn_type: sign.type,
      qty_base: sign.up ? qtyBase : str(neg(dec(qtyBase))),
    });
    return {
      qty_base: qtyBase,
      base_uom: units.baseUom,
      txns: [{ txn_id: posted.txn_id, txn_type: sign.type, location_code: from.code, lot_code: args.lot_code ?? null, balance_after: posted.balance_after }],
    };
  },
});
