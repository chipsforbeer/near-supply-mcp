import type pg from 'pg';
import { z } from 'zod';
import { OpError } from '../errors.ts';
import type { OpContext } from '../types.ts';

export const DOC_KINDS = ['spec_sheet', 'drawing', 'sds', 'coa', 'mill_cert', 'coc', 'quote', 'invoice', 'certificate', 'email', 'photo', 'note', 'other'] as const;
export const LINK_TYPES = ['item', 'item_spec', 'supplier', 'contact', 'rfq', 'quote', 'lot', 'purchase_order', 'production_run', 'wiki_page', 'interaction', 'evaluation'] as const;

const ENTITY_TABLE: Record<(typeof LINK_TYPES)[number], string> = {
  item: 'item', item_spec: 'item_spec', supplier: 'supplier', contact: 'contact', rfq: 'rfq', quote: 'quote', lot: 'lot',
  purchase_order: 'purchase_order', production_run: 'production_run', wiki_page: 'wiki_page', interaction: 'interaction', evaluation: 'evaluation',
};

export const linkSchema = z.object({ entity_type: z.enum(LINK_TYPES), entity_id: z.uuid(), role: z.string().max(120).optional() }).strict();
export type LinkInput = z.infer<typeof linkSchema>;

export async function addLinks(tx: pg.PoolClient, documentId: string, links: LinkInput[] | undefined): Promise<void> {
  for (const l of links ?? []) {
    const r = await tx.query(`SELECT 1 FROM ${ENTITY_TABLE[l.entity_type]} WHERE id = $1`, [l.entity_id]);
    if (!r.rowCount) throw new OpError('not_found', `No ${l.entity_type} ${l.entity_id} to link to.`);
    await tx.query(
      `INSERT INTO document_link (document_id, entity_type, entity_id, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, document_id, entity_type, entity_id) DO NOTHING`,
      [documentId, l.entity_type, l.entity_id, l.role ?? null],
    );
  }
}

export type NewDocument = {
  kind: (typeof DOC_KINDS)[number];
  title: string;
  source: 'mail' | 'note' | 'file' | 'url';
  location: string | null;
  sha256: string | null;
  size: number | null;
  mime: string | null;
  text: string | null;
  source_ref?: string | undefined;
  valid_until?: string | undefined;
  links?: LinkInput[] | undefined;
};

// Inserts the document row, or returns the existing one for the same content (sha256) or, when
// no hash is known, the same location.
export async function insertDocument(
  tx: pg.PoolClient,
  ctx: OpContext,
  d: NewDocument,
): Promise<{ document_id: string; duplicate: boolean; location: string | null; sha256: string | null; text_source: string }> {
  const existing = d.sha256
    ? await tx.query('SELECT id, location, sha256, text_source FROM document WHERE sha256 = $1', [d.sha256])
    : d.location
      ? await tx.query('SELECT id, location, sha256, text_source FROM document WHERE location = $1 ORDER BY captured_at LIMIT 1', [d.location])
      : { rows: [] };
  let row = existing.rows[0] as { id: string; location: string | null; sha256: string | null; text_source: string } | undefined;
  const duplicate = Boolean(row);
  if (!row) {
    const r = await tx.query(
      `INSERT INTO document (kind, title, mime, size_bytes, sha256, location, text_content, text_source, source, source_ref, valid_until, captured_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, location, sha256, text_source`,
      [d.kind, d.title, d.mime, d.size, d.sha256, d.location, d.text, d.text ? 'claude' : 'none', d.source,
        d.source_ref ?? null, d.valid_until ?? null, ctx.session.userId],
    );
    row = r.rows[0];
  }
  await addLinks(tx, row!.id, d.links);
  return { document_id: row!.id, duplicate, location: row!.location, sha256: row!.sha256, text_source: row!.text_source };
}
