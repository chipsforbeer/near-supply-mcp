import { z } from 'zod';
import { defineOp } from '../define.ts';
import { requireItem } from '../inventory/common.ts';
import { linkDocuments } from '../procurement/common.ts';
import { isoDate } from '../schemas.ts';

export default defineOp({
  name: 'spec_upsert',
  summary:
    'Save a new version of what an item must be, as plain text ("304 stainless, 1.5 mm +/- 0.08, 2B finish, EN 10204 3.1 mill cert") plus spec sheets or drawings (document_ids). The new active version supersedes the old.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      item_id: z.uuid(),
      body_md: z.string().trim().min(1).max(50000),
      status: z.enum(['active', 'draft']).default('active'),
      effective_from: isoDate.optional(),
      document_ids: z.array(z.uuid()).max(20).optional(),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const item = await requireItem(tx, args.item_id);
    const v = await tx.query('SELECT coalesce(max(version), 0) + 1 AS next FROM item_spec WHERE item_id = $1', [item.id]);
    if (args.status === 'active') {
      await tx.query(`UPDATE item_spec SET status = 'superseded' WHERE item_id = $1 AND status = 'active'`, [item.id]);
    }
    const r = await tx.query(
      `INSERT INTO item_spec (item_id, version, status, body_md, approved_by, effective_from)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, version, status, effective_from, created_at`,
      [item.id, v.rows[0].next, args.status, args.body_md, args.status === 'active' ? ctx.session.userId : null, args.effective_from ?? null],
    );
    await linkDocuments(tx, args.document_ids, 'item_spec', r.rows[0].id, 'our spec');
    return { spec_id: r.rows[0].id, sku: item.sku, ...r.rows[0] };
  },
});
