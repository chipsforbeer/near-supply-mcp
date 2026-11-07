import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { viaAgent } from '../types.ts';
import { requirePo } from './po-common.ts';
import { postTxn, packIdFor } from '../inventory/ledger.ts';
import { requireItem } from '../inventory/common.ts';
import { isoDate, isoDateTime, locationCode, positiveDecimal, unitFields } from '../schemas.ts';
import { loadItemUnits, toBase } from '../../domain/units.ts';
import { add, cmp, dec, str } from '../../domain/decimal.ts';

export default defineOp({
  name: 'po_receive',
  summary:
    'Receive goods against an approved PO into a location at its delivery site (quantity in any unit or pack). Lot-tracked items need lot_code; attach the certificate (COA, mill cert) as cert_document_id, then judge it with evaluation_log. Over-receipt is refused.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      po_id: z.uuid(),
      location_code: locationCode,
      occurred_at: isoDateTime.optional(),
      lines: z
        .array(
          z
            .object({
              po_line_id: z.uuid(),
              qty: positiveDecimal,
              ...unitFields,
              lot_code: z.string().trim().min(1).max(80).optional(),
              supplier_lot_code: z.string().max(80).optional(),
              expires_on: isoDate.optional(),
              cert_document_id: z.uuid().optional(),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const po = await requirePo(tx, args.po_id, true);
    if (!po.approved_at || po.status === 'draft' || po.status === 'cancelled') throw new OpError('conflict', `${po.po_code} is not approved.`);
    const loc = await tx.query(`SELECT id, code, kind FROM location WHERE site_id = $1 AND code = $2`, [po.site_id, args.location_code]);
    if (!loc.rows[0]) throw new OpError('not_found', `No location ${args.location_code} at the PO's delivery site.`);
    const location = loc.rows[0];
    const received = [];
    for (const line of args.lines) {
      const pl = await tx.query(
        'SELECT id, item_id, qty_base::text AS qty_base, received_qty_base::text AS received FROM po_line WHERE id = $1 AND po_id = $2 FOR UPDATE',
        [line.po_line_id, po.id],
      );
      if (!pl.rows[0]) throw new OpError('not_found', 'PO line not found on this PO.');
      const item = await requireItem(tx, pl.rows[0].item_id);
      const units = await loadItemUnits(tx, item.id);
      const qtyBase = toBase(line.qty, { uom: line.uom, pack: line.pack }, units);
      const after = add(dec(pl.rows[0].received), dec(qtyBase));
      if (cmp(after, dec(pl.rows[0].qty_base)) > 0) {
        throw new OpError('conflict', `Receiving ${qtyBase} ${units.baseUom} of ${item.sku} would exceed the ${pl.rows[0].qty_base} ordered (${pl.rows[0].received} already received).`);
      }
      if (line.cert_document_id) {
        const d = await tx.query('SELECT 1 FROM document WHERE id = $1', [line.cert_document_id]);
        if (!d.rowCount) throw new OpError('not_found', 'Certificate document not found.');
      }
      let lotId: string | null = null;
      if (item.is_lot_tracked) {
        if (!line.lot_code) throw new OpError('invalid_arguments', `${item.sku} is lot tracked; lot_code is required.`);
        const existing = await tx.query('SELECT id FROM lot WHERE item_id = $1 AND lot_code = $2', [item.id, line.lot_code]);
        if (existing.rows[0]) {
          lotId = existing.rows[0].id;
        } else {
          const lot = await tx.query(
            `INSERT INTO lot (item_id, lot_code, supplier_id, supplier_lot_code, received_on, expires_on, status, cert_document_id)
             VALUES ($1, $2, $3, $4, coalesce($5::timestamptz, now())::date, $6, $7, $8) RETURNING id`,
            [item.id, line.lot_code, po.supplier_id, line.supplier_lot_code ?? null, args.occurred_at ?? null, line.expires_on ?? null,
              location.kind === 'quarantine' ? 'quarantine' : 'released', line.cert_document_id ?? null],
          );
          lotId = lot.rows[0].id;
        }
      } else if (line.lot_code) {
        throw new OpError('invalid_arguments', `${item.sku} is not lot tracked; leave lot_code out.`);
      }
      const posted = await postTxn(tx, {
        item_id: item.id, location_id: location.id, lot_id: lotId, txn_type: 'receipt', qty_base: qtyBase,
        entered_qty: line.qty, entered_pack_id: await packIdFor(tx, item.id, line.pack), entered_uom: line.pack ? null : (line.uom ?? units.baseUom),
        reference_type: 'po', reference_id: po.id, occurred_at: args.occurred_at ?? null,
        actor_user_id: ctx.session.userId, via_agent: viaAgent(ctx.session),
      });
      await tx.query('UPDATE po_line SET received_qty_base = $2 WHERE id = $1', [pl.rows[0].id, str(after)]);
      received.push({ po_line_id: pl.rows[0].id, sku: item.sku, qty_base: qtyBase, lot_code: line.lot_code ?? null, txn_id: posted.txn_id });
    }
    const open = await tx.query('SELECT count(*)::int AS n FROM po_line WHERE po_id = $1 AND received_qty_base < qty_base', [po.id]);
    const status = open.rows[0].n === 0 ? 'received' : 'partially_received';
    await tx.query('UPDATE purchase_order SET status = $2 WHERE id = $1', [po.id, status]);
    return { po_code: po.po_code, status, received };
  },
});
