import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { METHOD_TYPES, requireSupplier, setList } from './common.ts';
import { normMethodValue } from '../../domain/normalize.ts';

const COLUMNS: Record<string, string> = {
  type: 'type_code', value: 'value', value_norm: 'value_norm', label: 'label', is_preferred: 'is_preferred',
  do_not_contact: 'do_not_contact', contact_id: 'contact_id',
};
const RETURNING = 'id, supplier_id, contact_id, type_code AS type, value, label, is_preferred, do_not_contact, removed_at';

export default defineOp({
  name: 'contact_method_update',
  summary:
    "Change one of a supplier's emails, phone numbers or other contact methods: correct the value or type, change the label, " +
    'preferred or do-not-contact flags, move it to a person or to the company (contact_id null), or retire it with remove: true ' +
    '(kept for history, hidden, never used for new contact). Fields left out keep their value.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      supplier_id: z.uuid(),
      contact_method_id: z.uuid(),
      type: z.enum(METHOD_TYPES).optional(),
      value: z.string().trim().min(1).max(300).optional(),
      label: z.string().max(80).nullable().optional(),
      is_preferred: z.boolean().optional(),
      do_not_contact: z.boolean().optional(),
      contact_id: z.uuid().nullable().optional(),
      remove: z.literal(true).optional(),
    })
    .strict(),
  async handler(args, tx) {
    await requireSupplier(tx, args.supplier_id);
    const cur = (
      await tx.query('SELECT id, type_code, value, contact_id FROM contact_method WHERE id = $1 AND supplier_id = $2 FOR UPDATE', [
        args.contact_method_id, args.supplier_id,
      ])
    ).rows[0] as { id: string; type_code: string; value: string; contact_id: string | null } | undefined;
    if (!cur) throw new OpError('not_found', 'Contact method not found for that supplier.');
    if (args.remove) {
      const r = await tx.query(`UPDATE contact_method SET removed_at = now(), is_preferred = false WHERE id = $1 RETURNING ${RETURNING}`, [cur.id]);
      return r.rows[0];
    }
    if (args.contact_id) {
      const c = await tx.query('SELECT 1 FROM contact WHERE id = $1 AND supplier_id = $2', [args.contact_id, args.supplier_id]);
      if (!c.rowCount) throw new OpError('not_found', 'Contact not found for that supplier.');
    }
    const fields: Record<string, unknown> = { ...args };
    if (args.type !== undefined || args.value !== undefined) {
      const type = args.type ?? cur.type_code;
      const value = args.value ?? cur.value;
      if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new OpError('invalid_arguments', `Not an email address: ${value}`);
      const norm = normMethodValue(type, value);
      if (!norm) throw new OpError('invalid_arguments', `Cannot use ${value} as a ${type}.`);
      fields.value_norm = norm;
    }
    const contactAfter = args.contact_id !== undefined ? args.contact_id : cur.contact_id;
    if (args.is_preferred) {
      await tx.query('UPDATE contact_method SET is_preferred = false WHERE supplier_id = $1 AND contact_id IS NOT DISTINCT FROM $2 AND id <> $3', [
        args.supplier_id, contactAfter, cur.id,
      ]);
    }
    const set = setList(COLUMNS, fields, 2);
    const r = await tx.query(
      set.sql.length
        ? `UPDATE contact_method SET ${set.sql.join(', ')} WHERE id = $1 RETURNING ${RETURNING}`
        : `SELECT ${RETURNING} FROM contact_method WHERE id = $1`,
      [cur.id, ...set.values],
    );
    return r.rows[0];
  },
});
