import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';

export default defineOp({
  name: 'lot_status_set',
  summary: 'Release, hold, reject or quarantine a lot. Only released lots count as usable stock. A note explaining why is required.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      lot_id: z.uuid(),
      status: z.enum(['released', 'on_hold', 'rejected', 'quarantine']),
      note: z.string().trim().min(3).max(1000),
    })
    .strict(),
  async handler(args, tx) {
    const r = await tx.query(
      `UPDATE lot SET status = $2, status_note = $3 WHERE id = $1
       RETURNING id, item_id, lot_code, status, status_note, expires_on`,
      [args.lot_id, args.status, args.note],
    );
    if (!r.rows[0]) throw new OpError('not_found', 'Lot not found.');
    return r.rows[0];
  },
});
