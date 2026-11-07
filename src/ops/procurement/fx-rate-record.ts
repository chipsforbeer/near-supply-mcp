import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { currency, isoDate, positiveDecimal } from '../schemas.ts';

export default defineOp({
  name: 'fx_rate_record',
  summary: 'Record an exchange rate you looked up (1 from_currency = rate to_currency), with its date and source. Quote comparison uses the latest one.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({ from_currency: currency, to_currency: currency, rate: positiveDecimal, as_of: isoDate, source: z.string().trim().min(3).max(300) })
    .strict(),
  async handler(args, tx, ctx) {
    if (args.from_currency === args.to_currency) throw new OpError('invalid_arguments', 'Currencies must differ.');
    const r = await tx.query(
      `INSERT INTO fx_rate (from_currency, to_currency, rate, as_of, source, recorded_by) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, from_currency, to_currency, rate, as_of, source`,
      [args.from_currency, args.to_currency, args.rate, args.as_of, args.source, ctx.session.userId],
    );
    return r.rows[0];
  },
});
