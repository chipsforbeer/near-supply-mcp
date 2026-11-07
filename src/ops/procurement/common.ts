import type pg from 'pg';
import { OpError } from '../errors.ts';

export async function requireRfq(tx: pg.PoolClient, rfqId: string): Promise<{ id: string; rfq_code: string; status: string; site_id: string }> {
  const r = await tx.query('SELECT id, rfq_code, status, site_id FROM rfq WHERE id = $1', [rfqId]);
  if (!r.rows[0]) throw new OpError('not_found', 'RFQ not found.');
  return r.rows[0];
}

export async function linkDocuments(
  tx: pg.PoolClient,
  documentIds: string[] | undefined,
  entityType: string,
  entityId: string,
  role: string | null = null,
): Promise<void> {
  for (const id of documentIds ?? []) {
    const d = await tx.query('SELECT 1 FROM document WHERE id = $1', [id]);
    if (!d.rowCount) throw new OpError('not_found', `Document ${id} not found.`);
    await tx.query(
      `INSERT INTO document_link (document_id, entity_type, entity_id, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [id, entityType, entityId, role],
    );
  }
}
