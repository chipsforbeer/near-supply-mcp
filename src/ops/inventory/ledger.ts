import type pg from 'pg';
import { OpError } from '../errors.ts';
import { add, dec, str } from '../../domain/decimal.ts';

export type TxnType =
  | 'opening_balance' | 'receipt' | 'production_output' | 'transfer_in'
  | 'issue' | 'production_consume' | 'transfer_out' | 'scrap' | 'return_to_supplier' | 'sample'
  | 'count_correction' | 'reversal';

export type TxnRow = {
  item_id: string;
  location_id: string;
  lot_id: string | null;
  txn_type: TxnType;
  qty_base: string;
  entered_qty?: string | null;
  entered_pack_id?: string | null;
  entered_uom?: string | null;
  counted_qty_base?: string | null;
  reference_type?: 'po' | 'production_run' | 'transfer' | 'count' | 'reversal' | null;
  reference_id?: string | null;
  reverses_txn_id?: string | number | null;
  note?: string | null;
  occurred_at?: string | null;
  actor_user_id: string;
  via_agent: boolean;
};

async function balanceRow(tx: pg.PoolClient, itemId: string, locationId: string, lotId: string | null, lock: boolean): Promise<string | null> {
  const r = await tx.query(
    `SELECT qty_base::text AS qty FROM stock_balance
      WHERE item_id = $1 AND location_id = $2 AND lot_id IS NOT DISTINCT FROM $3${lock ? ' FOR UPDATE' : ''}`,
    [itemId, locationId, lotId],
  );
  return r.rows[0]?.qty ?? null;
}

export async function balanceOf(tx: pg.PoolClient, itemId: string, locationId: string, lotId: string | null, lock = false): Promise<string> {
  return (await balanceRow(tx, itemId, locationId, lotId, lock)) ?? '0';
}

// The only way stock changes: one append-only ledger row plus the matching balance update,
// in the caller's transaction. A balance can never go below zero.
export async function postTxn(tx: pg.PoolClient, row: TxnRow): Promise<{ txn_id: string; balance_after: string }> {
  const existing = await balanceRow(tx, row.item_id, row.location_id, row.lot_id, true);
  const before = existing ?? '0';
  const after = add(dec(before), dec(row.qty_base));
  if (after < 0n) {
    const loc = await tx.query('SELECT code FROM location WHERE id = $1', [row.location_id]);
    throw new OpError('conflict', `Not enough stock: ${str(dec(before))} on hand at ${loc.rows[0]?.code ?? 'that location'}${row.lot_id ? ' for that lot' : ''}.`);
  }
  const t = await tx.query(
    `INSERT INTO stock_txn (item_id, location_id, lot_id, txn_type, qty_base, entered_qty, entered_pack_id, entered_uom,
                            counted_qty_base, reference_type, reference_id, reverses_txn_id, note, occurred_at, actor_user_id, via_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, coalesce($14::timestamptz, now()), $15, $16)
     RETURNING id`,
    [row.item_id, row.location_id, row.lot_id, row.txn_type, row.qty_base, row.entered_qty ?? null, row.entered_pack_id ?? null,
      row.entered_uom ?? null, row.counted_qty_base ?? null, row.reference_type ?? null, row.reference_id ?? null,
      row.reverses_txn_id ?? null, row.note ?? null, row.occurred_at ?? null, row.actor_user_id, row.via_agent],
  );
  if (existing !== null) {
    // The row is locked above, so a plain update is safe and never tries an invalid insert row.
    await tx.query(
      `UPDATE stock_balance SET qty_base = qty_base + $4, updated_at = now()
        WHERE item_id = $1 AND location_id = $2 AND lot_id IS NOT DISTINCT FROM $3`,
      [row.item_id, row.location_id, row.lot_id, row.qty_base],
    );
  } else {
    // No row yet, so the quantity is positive here; a concurrent first insert merges on conflict.
    await tx.query(
      `INSERT INTO stock_balance (item_id, location_id, lot_id, qty_base) VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, item_id, location_id, lot_id)
       DO UPDATE SET qty_base = stock_balance.qty_base + EXCLUDED.qty_base, updated_at = now()`,
      [row.item_id, row.location_id, row.lot_id, row.qty_base],
    );
  }
  return { txn_id: String(t.rows[0].id), balance_after: str(after) };
}

// Finds a lot by code, or creates it when `create` is given (receipts, counts, production output).
export async function resolveLot(
  tx: pg.PoolClient,
  item: { id: string; is_lot_tracked: boolean },
  lotCode: string | undefined,
  create?: { status: 'released' | 'quarantine'; expires_on?: string | null; manufactured_on?: string | null; received_on?: string | null },
): Promise<{ id: string; status: string } | null> {
  if (!item.is_lot_tracked) {
    if (lotCode) throw new OpError('invalid_arguments', 'This item is not lot tracked; leave lot_code out.');
    return null;
  }
  if (!lotCode) throw new OpError('invalid_arguments', 'This item is lot tracked; lot_code is required.');
  const found = await tx.query('SELECT id, status FROM lot WHERE item_id = $1 AND lot_code = $2', [item.id, lotCode]);
  if (found.rows[0]) return found.rows[0];
  if (!create) throw new OpError('not_found', `No lot ${lotCode} for this item.`);
  const r = await tx.query(
    `INSERT INTO lot (item_id, lot_code, status, expires_on, manufactured_on, received_on)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, status`,
    [item.id, lotCode, create.status, create.expires_on ?? null, create.manufactured_on ?? null, create.received_on ?? null],
  );
  return r.rows[0];
}

export async function packIdFor(tx: pg.PoolClient, itemId: string, pack: string | undefined): Promise<string | null> {
  if (!pack) return null;
  const r = await tx.query('SELECT id FROM item_pack WHERE item_id = $1 AND (lower(name) = lower($2) OR id::text = $2)', [itemId, pack]);
  return r.rows[0]?.id ?? null;
}
