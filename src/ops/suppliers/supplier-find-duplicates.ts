import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { findDuplicates } from './common.ts';

export default defineOp({
  name: 'supplier_find_duplicates',
  summary:
    'Before adding a supplier, check whether it already exists: matches on normalised name (ignoring Ltd, Inc...), company email or website domain, and phone number.',
  kind: 'read',
  scope: 'read',
  input: z
    .object({
      name: z.string().max(200).optional(),
      website: z.string().max(300).optional(),
      email: z.string().max(300).optional(),
      phone: z.string().max(60).optional(),
    })
    .strict(),
  async handler(args, tx) {
    if (!args.name && !args.website && !args.email && !args.phone) {
      throw new OpError('invalid_arguments', 'Give at least one of name, website, email or phone.');
    }
    return { matches: await findDuplicates(tx, args) };
  },
});
