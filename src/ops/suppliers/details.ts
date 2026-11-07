import type pg from 'pg';
import { OpError } from '../errors.ts';
import { setList } from './common.ts';

// Offerings: shared by supplier_offering_upsert and supplier_import.

type Opt<T> = T | null | undefined;

export type OfferingInput = {
  offering_id?: string | undefined;
  kind?: 'product' | 'service' | undefined;
  category?: string | undefined;
  description?: Opt<string>;
  tags?: string[] | undefined;
  min_order?: Opt<string>;
  lead_time_days_min?: Opt<number>;
  lead_time_days_max?: Opt<number>;
  price_note?: Opt<string>;
  source?: Opt<string>;
  document_id?: Opt<string>;
  status?: 'active' | 'discontinued' | undefined;
};

const COLUMNS: Record<string, string> = {
  kind: 'kind', category: 'category', description: 'description', tags: 'tags', min_order: 'min_order',
  lead_time_days_min: 'lead_time_days_min', lead_time_days_max: 'lead_time_days_max', price_note: 'price_note',
  source: 'source', document_id: 'document_id', status: 'status',
};

const OFFERING_COLS = `id AS offering_id, supplier_id, kind, category, description, tags, min_order, lead_time_days_min,
  lead_time_days_max, price_note, source, document_id, status, updated_at`;

async function requireDocument(tx: pg.PoolClient, id: string): Promise<void> {
  const r = await tx.query('SELECT 1 FROM document WHERE id = $1', [id]);
  if (!r.rowCount) throw new OpError('not_found', 'Document not found.');
}

// On update, a field left out keeps its value and null clears it.
export async function saveOffering(tx: pg.PoolClient, supplierId: string, o: OfferingInput): Promise<Record<string, unknown>> {
  if (typeof o.lead_time_days_min === 'number' && typeof o.lead_time_days_max === 'number' && o.lead_time_days_min > o.lead_time_days_max) {
    throw new OpError('invalid_arguments', 'lead_time_days_min must not be more than lead_time_days_max.');
  }
  if (o.document_id) await requireDocument(tx, o.document_id);
  const values = [o.kind ?? null, o.category ?? null, o.description ?? null, o.tags ?? null, o.min_order ?? null,
    o.lead_time_days_min ?? null, o.lead_time_days_max ?? null, o.price_note ?? null, o.source ?? null, o.document_id ?? null, o.status ?? null];
  if (!o.offering_id) {
    if (!o.kind || !o.category) throw new OpError('invalid_arguments', 'A new offering needs kind and category.');
    const r = await tx.query(
      `INSERT INTO supplier_offering (supplier_id, kind, category, description, tags, min_order, lead_time_days_min,
                                      lead_time_days_max, price_note, source, document_id, status)
       VALUES ($1, $2, $3, $4, coalesce($5::text[], '{}'), $6, $7, $8, $9, $10, $11, coalesce($12, 'active'))
       RETURNING ${OFFERING_COLS}`,
      [supplierId, ...values],
    );
    return r.rows[0];
  }
  const set = setList(COLUMNS, o, 3);
  const r = await tx.query(
    `UPDATE supplier_offering SET ${[...set.sql, 'updated_at = now()'].join(', ')}
      WHERE id = $1 AND supplier_id = $2
      RETURNING ${OFFERING_COLS}`,
    [o.offering_id, supplierId, ...set.values],
  );
  if (!r.rows[0]) throw new OpError('not_found', 'Offering not found for this supplier.');
  return r.rows[0];
}
