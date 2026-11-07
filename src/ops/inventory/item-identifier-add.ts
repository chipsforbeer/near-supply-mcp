import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { IDENTIFIER_KINDS, requireItem } from './common.ts';

export default defineOp({
  name: 'item_identifier_add',
  summary:
    'Add a name the outside world uses for an item: mpn (with manufacturer), cas, drawing (with revision), standard, hs_code, gtin or alias.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      item_id: z.uuid(),
      kind: z.enum(IDENTIFIER_KINDS),
      value: z.string().trim().min(1).max(120),
      manufacturer: z.string().trim().max(120).optional(),
      revision: z.string().trim().max(20).optional(),
      document_id: z.uuid().optional(),
      is_primary: z.boolean().optional(),
    })
    .strict(),
  async handler(args, tx) {
    await requireItem(tx, args.item_id);
    if (args.document_id) {
      const d = await tx.query('SELECT 1 FROM document WHERE id = $1', [args.document_id]);
      if (!d.rowCount) throw new OpError('not_found', 'Document not found.');
    }
    if (args.is_primary) {
      await tx.query('UPDATE item_identifier SET is_primary = false WHERE item_id = $1 AND kind = $2', [args.item_id, args.kind]);
    }
    const r = await tx.query(
      `INSERT INTO item_identifier (item_id, kind, value, manufacturer, revision, document_id, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, coalesce($7, false))
       ON CONFLICT (company_id, item_id, kind, value) DO UPDATE
         SET manufacturer = coalesce(EXCLUDED.manufacturer, item_identifier.manufacturer),
             revision = coalesce(EXCLUDED.revision, item_identifier.revision),
             document_id = coalesce(EXCLUDED.document_id, item_identifier.document_id),
             is_primary = EXCLUDED.is_primary OR item_identifier.is_primary
       RETURNING id, item_id, kind, value, manufacturer, revision, document_id, is_primary`,
      [args.item_id, args.kind, args.value, args.manufacturer ?? null, args.revision ?? null, args.document_id ?? null, args.is_primary ?? null],
    );
    return r.rows[0];
  },
});
