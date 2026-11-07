import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { requireItem } from '../inventory/common.ts';

export default defineOp({
  name: 'spec_get',
  summary: 'The active (or a given version of the) spec for an item, with its spec sheets and drawings.',
  kind: 'read',
  scope: 'read',
  input: z.object({ item_id: z.uuid(), version: z.number().int().positive().optional() }).strict(),
  async handler(args, tx) {
    const item = await requireItem(tx, args.item_id);
    const r = await tx.query(
      `SELECT s.id AS spec_id, s.version, s.status, s.body_md, s.effective_from, s.created_at, u.email AS approved_by
         FROM item_spec s LEFT JOIN app_user u ON u.id = s.approved_by
        WHERE s.item_id = $1 AND (($2::int IS NULL AND s.status = 'active') OR s.version = $2)`,
      [item.id, args.version ?? null],
    );
    const spec = r.rows[0];
    if (!spec) throw new OpError('not_found', args.version ? `No spec version ${args.version} for ${item.sku}.` : `${item.sku} has no active spec.`);
    const docs = await tx.query(
      `SELECT d.id, d.kind, d.title, d.valid_until, l.role FROM document_link l JOIN document d ON d.id = l.document_id
        WHERE l.entity_type = 'item_spec' AND l.entity_id = $1`,
      [spec.spec_id],
    );
    return { sku: item.sku, ...spec, documents: docs.rows };
  },
});
