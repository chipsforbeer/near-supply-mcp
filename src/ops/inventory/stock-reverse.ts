import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { viaAgent } from '../types.ts';
import { postTxn } from './ledger.ts';
import { dec, neg, str } from '../../domain/decimal.ts';

export default defineOp({
  name: 'stock_reverse',
  summary:
    'Undo a ledger row by posting its exact opposite (the original stays, nothing is deleted). Reversing one half of a transfer reverses both halves. A row can be reversed once.',
  kind: 'write',
  scope: 'write',
  input: z.object({ txn_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]), note: z.string().trim().min(1).max(1000) }).strict(),
  async handler(args, tx, ctx) {
    const first = await tx.query('SELECT * FROM stock_txn WHERE id = $1', [String(args.txn_id)]);
    const txn = first.rows[0];
    if (!txn) throw new OpError('not_found', 'Ledger row not found.');
    if (txn.txn_type === 'reversal') throw new OpError('invalid_arguments', 'A reversal cannot itself be reversed; record a new movement instead.');
    const targets = txn.reference_type === 'transfer'
      ? (await tx.query(`SELECT * FROM stock_txn WHERE reference_type = 'transfer' AND reference_id = $1 ORDER BY id`, [txn.reference_id])).rows
      : [txn];
    const reversed = await tx.query('SELECT reverses_txn_id FROM stock_txn WHERE reverses_txn_id = ANY($1)', [targets.map((t) => t.id)]);
    if (reversed.rowCount) throw new OpError('conflict', 'That ledger row has already been reversed.');
    // Reverse incoming halves last so an outgoing reversal never dips below zero first.
    targets.sort((a, b) => (dec(a.qty_base) > dec(b.qty_base) ? -1 : 1));
    const posted = [];
    for (const t of targets) {
      const r = await postTxn(tx, {
        item_id: t.item_id,
        location_id: t.location_id,
        lot_id: t.lot_id,
        txn_type: 'reversal',
        qty_base: str(neg(dec(t.qty_base))),
        reverses_txn_id: t.id,
        reference_type: 'reversal',
        note: args.note,
        actor_user_id: ctx.session.userId,
        via_agent: viaAgent(ctx.session),
      });
      posted.push({ txn_id: r.txn_id, reverses_txn_id: String(t.id), balance_after: r.balance_after });
    }
    return { reversals: posted };
  },
});
