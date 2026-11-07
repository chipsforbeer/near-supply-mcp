import type pg from 'pg';
import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { viaAgent } from '../types.ts';
import { linkDocuments } from '../procurement/common.ts';

export const SUBJECT_TYPES = ['quote', 'quote_line', 'lot', 'supplier_item', 'supplier'] as const;

type Subject = { itemId: string | null; quoteId: string | null };

async function loadSubject(tx: pg.PoolClient, type: (typeof SUBJECT_TYPES)[number], id: string): Promise<Subject> {
  const queries: Record<string, string> = {
    quote: 'SELECT NULL::uuid AS item_id, id AS quote_id FROM quote WHERE id = $1',
    quote_line: 'SELECT item_id, quote_id FROM quote_line WHERE id = $1',
    lot: 'SELECT item_id, NULL::uuid AS quote_id FROM lot WHERE id = $1',
    supplier_item: 'SELECT item_id, NULL::uuid AS quote_id FROM supplier_item WHERE id = $1',
    supplier: 'SELECT NULL::uuid AS item_id, NULL::uuid AS quote_id FROM supplier WHERE id = $1',
  };
  const r = await tx.query(queries[type]!, [id]);
  if (!r.rows[0]) throw new OpError('not_found', `No ${type} with that id.`);
  return { itemId: r.rows[0].item_id, quoteId: r.rows[0].quote_id };
}

export default defineOp({
  name: 'evaluation_log',
  summary:
    'Record your verdict on a quote, quote line, delivered lot, supplier item or supplier: good, not_good or needs_info, with your reasoning and the evidence documents. It is judged against the item\'s active spec unless spec_version is given. not_good on a lot quarantines it; not_good on a quote disqualifies that supplier on the RFQ.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      subject_type: z.enum(SUBJECT_TYPES),
      subject_id: z.uuid(),
      verdict: z.enum(['good', 'not_good', 'needs_info']),
      reasoning: z.string().trim().min(10).max(8000),
      spec_version: z.number().int().positive().optional(),
      evidence_document_ids: z.array(z.uuid()).max(20).optional(),
      supersedes_id: z.uuid().optional(),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const subject = await loadSubject(tx, args.subject_type, args.subject_id);
    let specId: string | null = null;
    if (subject.itemId) {
      const s = await tx.query(
        `SELECT id FROM item_spec WHERE item_id = $1 AND (($2::int IS NULL AND status = 'active') OR version = $2)`,
        [subject.itemId, args.spec_version ?? null],
      );
      if (args.spec_version && !s.rows[0]) throw new OpError('not_found', `No spec version ${args.spec_version} for that item.`);
      specId = s.rows[0]?.id ?? null;
    } else if (args.spec_version) {
      throw new OpError('invalid_arguments', 'spec_version only applies to subjects tied to one item.');
    }
    if (args.supersedes_id) {
      const prev = await tx.query('SELECT 1 FROM evaluation WHERE id = $1 AND subject_type = $2 AND subject_id = $3', [args.supersedes_id, args.subject_type, args.subject_id]);
      if (!prev.rowCount) throw new OpError('invalid_arguments', 'supersedes_id must be an earlier evaluation of the same subject.');
    }
    for (const id of args.evidence_document_ids ?? []) {
      const d = await tx.query('SELECT 1 FROM document WHERE id = $1', [id]);
      if (!d.rowCount) throw new OpError('not_found', `Evidence document ${id} not found.`);
    }
    const e = await tx.query(
      `INSERT INTO evaluation (subject_type, subject_id, spec_id, verdict, reasoning, evidence_document_ids, decided_by, via_agent, supersedes_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, decided_at`,
      [args.subject_type, args.subject_id, specId, args.verdict, args.reasoning, args.evidence_document_ids ?? [], ctx.session.userId,
        viaAgent(ctx.session), args.supersedes_id ?? null],
    );
    await linkDocuments(tx, args.evidence_document_ids, 'evaluation', e.rows[0].id, 'evidence');

    const effects: string[] = [];
    if (args.verdict === 'not_good' && args.subject_type === 'lot') {
      await tx.query(`UPDATE lot SET status = 'quarantine', status_note = $2 WHERE id = $1`, [args.subject_id, `Evaluation not_good: ${args.reasoning}`.slice(0, 1000)]);
      effects.push('lot quarantined');
    }
    if (args.verdict === 'not_good' && subject.quoteId) {
      const r = await tx.query(
        `UPDATE rfq_recipient rr SET status = 'disqualified', status_note = $2
           FROM quote q WHERE q.id = $1 AND rr.rfq_id = q.rfq_id AND rr.supplier_id = q.supplier_id RETURNING rr.supplier_id`,
        [subject.quoteId, args.reasoning.slice(0, 200)],
      );
      if (r.rowCount) effects.push('supplier disqualified on the RFQ');
    }
    const version = specId ? (await tx.query('SELECT version FROM item_spec WHERE id = $1', [specId])).rows[0].version : null;
    return { evaluation_id: e.rows[0].id, verdict: args.verdict, spec_version: version, decided_at: e.rows[0].decided_at, effects };
  },
});
