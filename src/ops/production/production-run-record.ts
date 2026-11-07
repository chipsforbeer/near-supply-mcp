import type pg from 'pg';
import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { viaAgent } from '../types.ts';
import { requireItem, requireLocation } from '../inventory/common.ts';
import { balanceOf, postTxn, resolveLot } from '../inventory/ledger.ts';
import { isoDateTime, locationCode, positiveDecimal, siteCode, unitFields } from '../schemas.ts';
import { loadItemUnits, toBase } from '../../domain/units.ts';
import { add, cmp, dec, div, mul, neg, str, sub, type Dec } from '../../domain/decimal.ts';
import { loadBom } from './bom-get.ts';

type Allocation = { lot_id: string | null; lot_code: string | null; qty: Dec };

// Lot-tracked components without a named lot are taken first-expiring-first from released lots.
async function allocate(
  tx: pg.PoolClient,
  item: { id: string; sku: string; is_lot_tracked: boolean },
  locationId: string,
  need: Dec,
  lotCode: string | undefined,
): Promise<Allocation[]> {
  if (!item.is_lot_tracked || lotCode) {
    const lot = await resolveLot(tx, item, lotCode);
    if (lot && lot.status !== 'released') throw new OpError('conflict', `Lot ${lotCode} of ${item.sku} is ${lot.status}, not released.`);
    return [{ lot_id: lot?.id ?? null, lot_code: lotCode ?? null, qty: need }];
  }
  const lots = await tx.query(
    `SELECT b.lot_id, lt.lot_code, b.qty_base::text AS qty
       FROM stock_balance b JOIN lot lt ON lt.id = b.lot_id
      WHERE b.item_id = $1 AND b.location_id = $2 AND b.qty_base > 0 AND lt.status = 'released'
      ORDER BY lt.expires_on NULLS LAST, lt.received_on NULLS LAST, lt.lot_code
      FOR UPDATE OF b`,
    [item.id, locationId],
  );
  const out: Allocation[] = [];
  let rest = need;
  for (const row of lots.rows) {
    if (rest <= 0n) break;
    const take = cmp(dec(row.qty), rest) < 0 ? dec(row.qty) : rest;
    out.push({ lot_id: row.lot_id, lot_code: row.lot_code, qty: take });
    rest = sub(rest, take);
  }
  if (rest > 0n) {
    throw new OpError('conflict', `Not enough released stock of ${item.sku}: short by ${str(rest)}.`);
  }
  return out;
}

export default defineOp({
  name: 'production_run_record',
  summary:
    'Record a finished production run (batch, work order). Consumes each BOM component, scaled to the actual output plus its scrap factor, unless you give actual_lines amounts; adds the output to stock. All or nothing.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      output_item_id: z.uuid(),
      run_code: z.string().trim().min(1).max(60),
      site_code: siteCode,
      consume_location_code: locationCode,
      output_location_code: locationCode,
      actual_output_qty: positiveDecimal,
      planned_qty: positiveDecimal.optional(),
      ...unitFields,
      bom_version: z.number().int().positive().optional(),
      actual_lines: z
        .array(z.object({ item_id: z.uuid(), qty: positiveDecimal, ...unitFields, lot_code: z.string().max(80).optional() }).strict())
        .max(200)
        .optional(),
      component_lots: z.array(z.object({ item_id: z.uuid(), lot_code: z.string().min(1).max(80) }).strict()).max(200).optional(),
      output_lot_code: z.string().trim().min(1).max(80).optional(),
      started_at: isoDateTime.optional(),
      finished_at: isoDateTime.optional(),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const output = await requireItem(tx, args.output_item_id);
    const outUnits = await loadItemUnits(tx, output.id);
    const actualOut = toBase(args.actual_output_qty, { uom: args.uom, pack: args.pack }, outUnits);
    const planned = args.planned_qty ? toBase(args.planned_qty, { uom: args.uom, pack: args.pack }, outUnits) : actualOut;
    const bom = await loadBom(tx, output.id, args.bom_version);
    const consumeAt = await requireLocation(tx, args.site_code, args.consume_location_code);
    const outputAt = await requireLocation(tx, args.site_code, args.output_location_code);
    const exists = await tx.query('SELECT 1 FROM production_run WHERE run_code = $1', [args.run_code]);
    if (exists.rowCount) throw new OpError('conflict', `Run ${args.run_code} is already recorded.`);

    const actualByItem = new Map((args.actual_lines ?? []).map((l) => [l.item_id, l]));
    for (const id of actualByItem.keys()) {
      if (!bom.lines.some((l: { item_id: string }) => l.item_id === id)) {
        throw new OpError('invalid_arguments', 'actual_lines may only name components of the BOM.');
      }
    }
    const lotByItem = new Map((args.component_lots ?? []).map((l) => [l.item_id, l.lot_code]));

    const run = await tx.query(
      `INSERT INTO production_run (bom_id, site_id, run_code, planned_qty_base, actual_output_base, status, started_at, finished_at, created_by)
       VALUES ($1, $2, $3, $4, $5, 'done', $6, coalesce($7::timestamptz, now()), $8)
       RETURNING id, run_code, status, planned_qty_base, actual_output_base, finished_at`,
      [bom.id, consumeAt.site_id, args.run_code, planned, actualOut, args.started_at ?? null, args.finished_at ?? null, ctx.session.userId],
    );
    const runId = run.rows[0].id as string;
    const actor = { actor_user_id: ctx.session.userId, via_agent: viaAgent(ctx.session) };
    const scale = div(dec(actualOut), dec(bom.batch_qty_base));

    const consumed = [];
    for (const line of bom.lines) {
      const component = { id: line.item_id, sku: line.sku, is_lot_tracked: line.is_lot_tracked };
      const actual = actualByItem.get(line.item_id);
      let need: Dec;
      if (actual) {
        need = dec(toBase(actual.qty, { uom: actual.uom, pack: actual.pack }, await loadItemUnits(tx, line.item_id)));
      } else {
        const base = line.scales_with_batch ? mul(dec(line.qty_base), scale) : dec(line.qty_base);
        need = mul(base, add(dec('1'), dec(line.scrap_factor)));
      }
      const allocations = await allocate(tx, component, consumeAt.id, need, actual?.lot_code ?? lotByItem.get(line.item_id));
      const lots = [];
      for (const a of allocations) {
        const posted = await postTxn(tx, {
          item_id: line.item_id, location_id: consumeAt.id, lot_id: a.lot_id, txn_type: 'production_consume',
          qty_base: str(neg(a.qty)), reference_type: 'production_run', reference_id: runId,
          occurred_at: args.finished_at ?? null, ...actor,
        });
        lots.push({ lot_code: a.lot_code, qty_base: str(a.qty), txn_id: posted.txn_id });
      }
      consumed.push({ item_id: line.item_id, sku: line.sku, qty_base: str(need), base_uom: line.base_uom, from_actual: Boolean(actual), lots });
    }

    const outLotCode = output.is_lot_tracked ? (args.output_lot_code ?? args.run_code) : undefined;
    if (!output.is_lot_tracked && args.output_lot_code) throw new OpError('invalid_arguments', 'The output item is not lot tracked; leave output_lot_code out.');
    const outLot = await resolveLot(tx, output, outLotCode, { status: outputAt.kind === 'quarantine' ? 'quarantine' : 'released' });
    const produced = await postTxn(tx, {
      item_id: output.id, location_id: outputAt.id, lot_id: outLot?.id ?? null, txn_type: 'production_output',
      qty_base: actualOut, reference_type: 'production_run', reference_id: runId, occurred_at: args.finished_at ?? null, ...actor,
    });
    if (outLot) await tx.query('UPDATE production_run SET output_lot_id = $2 WHERE id = $1', [runId, outLot.id]);
    const onHand = await balanceOf(tx, output.id, outputAt.id, outLot?.id ?? null);
    return {
      run: { ...run.rows[0], bom_version: bom.version },
      consumed,
      output: { sku: output.sku, qty_base: actualOut, base_uom: outUnits.baseUom, lot_code: outLotCode ?? null, txn_id: produced.txn_id, on_hand: onHand },
    };
  },
});
