import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { contactFields, insertContact, requireSupplier, setList } from './common.ts';

const COLUMNS: Record<string, string> = {
  full_name: 'full_name', job_title: 'job_title', department: 'department', is_primary: 'is_primary', handles: 'handles',
  language: 'language', timezone: 'timezone', may_contact_on_behalf: 'may_contact_on_behalf', status: 'status', notes: 'notes',
};

export default defineOp({
  name: 'contact_upsert',
  summary:
    'Add or update a person at a supplier: what they handle (quotes, orders, quality...), their language (write to them in it), ' +
    "and whether we may contact them on the user's behalf. Updating (contact_id) changes only the fields passed; null clears one.",
  kind: 'write',
  scope: 'write',
  input: z
    .object({ contact_id: z.uuid().optional(), supplier_id: z.uuid(), ...contactFields, full_name: contactFields.full_name.optional() })
    .strict(),
  async handler(args, tx) {
    await requireSupplier(tx, args.supplier_id);
    if (!args.contact_id) {
      if (!args.full_name) throw new OpError('invalid_arguments', 'A new contact needs full_name.');
      const id = await insertContact(tx, args.supplier_id, args);
      const r = await tx.query('SELECT * FROM contact WHERE id = $1', [id]);
      const { company_id: _c, ...contact } = r.rows[0];
      return { created: true, contact };
    }
    if (args.is_primary) await tx.query('UPDATE contact SET is_primary = false WHERE supplier_id = $1 AND id <> $2', [args.supplier_id, args.contact_id]);
    const set = setList(COLUMNS, args, 3);
    const r = await tx.query(
      set.sql.length
        ? `UPDATE contact SET ${set.sql.join(', ')} WHERE id = $1 AND supplier_id = $2 RETURNING *`
        : 'SELECT * FROM contact WHERE id = $1 AND supplier_id = $2',
      [args.contact_id, args.supplier_id, ...set.values],
    );
    if (!r.rows[0]) throw new OpError('not_found', 'Contact not found for that supplier.');
    const { company_id: _c, ...contact } = r.rows[0];
    return { created: false, contact };
  },
});
