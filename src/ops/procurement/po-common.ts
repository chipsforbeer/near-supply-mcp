import type pg from 'pg';
import { OpError } from '../errors.ts';

export type PoRow = {
  id: string; po_code: string; supplier_id: string; quote_id: string | null; rfq_id: string | null; site_id: string;
  status: string; currency: string; total: string; approved_by: string | null; approved_at: string | null;
  approved_max_amount: string | null; payment_status: string;
};

export async function requirePo(tx: pg.PoolClient, poId: string, lock = false): Promise<PoRow> {
  const r = await tx.query(`SELECT *, total::text AS total, approved_max_amount::text AS approved_max_amount FROM purchase_order WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [poId]);
  if (!r.rows[0]) throw new OpError('not_found', 'Purchase order not found.');
  return r.rows[0];
}
