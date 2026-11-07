import { z } from 'zod';
import { defineOp } from '../define.ts';

export default defineOp({
  name: 'container_type_list',
  summary: 'Container types available for packs: shared defaults (drum, IBC, sack, keg...) plus this company\'s own.',
  kind: 'read',
  scope: 'read',
  input: z.object({}).strict(),
  async handler(_args, tx) {
    const r = await tx.query(
      `SELECT kind, name, nominal_capacity, capacity_uom, is_returnable, company_id IS NULL AS shared
         FROM container_type ORDER BY kind, nominal_capacity NULLS FIRST, name`,
    );
    return { items: r.rows };
  },
});
