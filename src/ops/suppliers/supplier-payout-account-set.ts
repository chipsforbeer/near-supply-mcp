import { z } from 'zod';
import { defineOp } from '../define.ts';
import { requireSupplier } from './common.ts';

// Named NEAR accounts (example.near, shop.example.testnet) or 64-hex implicit accounts.
const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export default defineOp({
  name: 'supplier_payout_account_set',
  summary:
    'Set where a supplier is paid (approve scope only). Replaces the current account and keeps the old one on record. Changing payout details is a classic fraud route: confirm the change with the supplier on a known channel first.',
  kind: 'write',
  scope: 'approve',
  input: z
    .object({
      supplier_id: z.uuid(),
      network: z.literal('near'),
      account_id: z.string().trim().regex(NEAR_ACCOUNT, 'Not a valid NEAR account id.'),
      token: z.string().trim().min(1).max(100),
      note: z.string().trim().min(5).max(1000),
    })
    .strict(),
  async handler(args, tx, ctx) {
    await requireSupplier(tx, args.supplier_id);
    const previous = await tx.query(
      `UPDATE supplier_payout_account SET superseded_at = now()
        WHERE supplier_id = $1 AND network = $2 AND superseded_at IS NULL
        RETURNING account_id`,
      [args.supplier_id, args.network],
    );
    const r = await tx.query(
      `INSERT INTO supplier_payout_account (supplier_id, network, account_id, token, note, set_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, network, account_id, token, set_at`,
      [args.supplier_id, args.network, args.account_id, args.token, args.note, ctx.session.userId],
    );
    return { ...r.rows[0], replaced: previous.rows[0]?.account_id ?? null };
  },
});
