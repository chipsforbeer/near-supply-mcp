import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { LOCATION_KINDS, requireUom } from './common.ts';
import { locationCode, positiveDecimal, siteCode, uomCode } from '../schemas.ts';

export default defineOp({
  name: 'location_upsert',
  summary:
    'Create or update a storage location (rack, bin, tank, cold room, quarantine...) at a site. Creates the site too when site_name and timezone are given.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      site_code: siteCode,
      site_name: z.string().trim().min(1).max(120).optional(),
      timezone: z.string().trim().min(1).max(60).optional(),
      code: locationCode,
      name: z.string().trim().min(1).max(120),
      kind: z.enum(LOCATION_KINDS),
      parent_code: locationCode.optional(),
      capacity: positiveDecimal.optional(),
      capacity_uom: uomCode.optional(),
    })
    .strict(),
  async handler(args, tx) {
    let site = (await tx.query('SELECT id, code FROM site WHERE code = $1', [args.site_code])).rows[0];
    if (!site) {
      if (!args.site_name || !args.timezone) {
        throw new OpError('invalid_arguments', `Site ${args.site_code} does not exist; give site_name and timezone to create it.`);
      }
      if (!Intl.supportedValuesOf('timeZone').includes(args.timezone) && args.timezone !== 'UTC') {
        throw new OpError('invalid_arguments', `Unknown timezone ${args.timezone}; use an IANA name such as Asia/Taipei.`);
      }
      site = (await tx.query('INSERT INTO site (code, name, timezone) VALUES ($1, $2, $3) RETURNING id, code', [args.site_code, args.site_name, args.timezone])).rows[0];
    }
    if (args.capacity_uom) await requireUom(tx, args.capacity_uom);
    let parentId: string | null = null;
    if (args.parent_code) {
      const p = await tx.query('SELECT id FROM location WHERE site_id = $1 AND code = $2', [site.id, args.parent_code]);
      if (!p.rows[0]) throw new OpError('not_found', `No parent location ${args.parent_code} at ${args.site_code}.`);
      parentId = p.rows[0].id;
    }
    const r = await tx.query(
      `INSERT INTO location (site_id, parent_id, code, name, kind, capacity, capacity_uom)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id, site_id, code) DO UPDATE
         SET parent_id = EXCLUDED.parent_id, name = EXCLUDED.name, kind = EXCLUDED.kind,
             capacity = EXCLUDED.capacity, capacity_uom = EXCLUDED.capacity_uom
       RETURNING id, code, name, kind, capacity, capacity_uom`,
      [site.id, parentId, args.code, args.name, args.kind, args.capacity ?? null, args.capacity_uom ?? null],
    );
    return { site_code: site.code, location: r.rows[0] };
  },
});
