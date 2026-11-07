import type pg from 'pg';
import { z } from 'zod';
import { OpError } from '../errors.ts';
import { companyDomain, normMethodValue, normName, phoneTail } from '../../domain/normalize.ts';
import { currency } from '../schemas.ts';

export const SUPPLIER_TYPES = ['manufacturer', 'distributor', 'trader', 'job_shop', 'service'] as const;
export const SUPPLIER_STATUSES = ['prospect', 'approved', 'preferred', 'on_hold', 'blocked'] as const;
export const HANDLES = ['quotes', 'orders', 'quality', 'accounts', 'technical', 'logistics'] as const;
export const METHOD_TYPES = ['email', 'phone', 'mobile', 'sms', 'whatsapp', 'line', 'wechat', 'telegram', 'signal',
  'fax', 'website_form', 'portal', 'linkedin'] as const;
export const ADDRESS_KINDS = ['hq', 'factory', 'warehouse', 'billing', 'pickup'] as const;

const country = z.string().regex(/^[A-Z]{2}$/, 'Two-letter country code, for example TW.');

export const addressSchema = z
  .object({
    kind: z.enum(ADDRESS_KINDS),
    lines: z.string().trim().min(1).max(500),
    city: z.string().max(120).optional(),
    region: z.string().max(120).optional(),
    postal_code: z.string().max(20).optional(),
    country_code: country.optional(),
  })
  .strict();

export const methodSchema = z
  .object({
    type: z.enum(METHOD_TYPES),
    value: z.string().trim().min(1).max(300),
    label: z.string().max(80).optional(),
    is_preferred: z.boolean().optional(),
    do_not_contact: z.boolean().optional(),
  })
  .strict();

// Optional fields: leave out to keep the current value, pass null to clear it.
const clearable = <T extends z.ZodType>(t: T) => t.nullable().optional();

export const contactFields = {
  full_name: z.string().trim().min(1).max(160),
  job_title: clearable(z.string().max(120)),
  department: clearable(z.string().max(120)),
  is_primary: z.boolean().optional(),
  handles: z.array(z.enum(HANDLES)).max(6).optional(),
  language: clearable(z.string().max(20)),
  timezone: clearable(z.string().max(60)),
  may_contact_on_behalf: z.boolean().optional(),
  status: z.enum(['active', 'left']).optional(),
  notes: clearable(z.string().max(2000)),
};

export const supplierFields = {
  name: z.string().trim().min(1).max(200),
  legal_name: clearable(z.string().max(200)),
  website: clearable(z.string().max(300)),
  email_domain: clearable(z.string().max(200)),
  country_code: clearable(country),
  supplier_type: clearable(z.enum(SUPPLIER_TYPES)),
  capabilities: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  currency: clearable(currency),
  payment_terms: clearable(z.string().max(200)),
  incoterms: clearable(z.string().max(40)),
  origin: z.enum(['existing', 'discovered']).optional(),
  discovered_for_rfq: clearable(z.uuid()),
  discovery_sources: z.array(z.string().max(500)).max(20).optional(),
  status: z.enum(SUPPLIER_STATUSES).optional(),
  tags: z.array(z.string().max(40)).max(30).optional(),
  rating: clearable(z.number().int().min(1).max(5)),
  notes: clearable(z.string().max(4000)),
  tax_id: clearable(z.string().trim().min(1).max(60)),
  registration_number: clearable(z.string().trim().min(1).max(60)),
  addresses: z.array(addressSchema).max(10).optional(),
};

// What a supplier can supply in general, beyond the items we already buy from them.
export const offeringFields = {
  kind: z.enum(['product', 'service']),
  category: z.string().trim().min(1).max(120),
  description: clearable(z.string().max(2000)),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  min_order: clearable(z.string().max(200)),
  lead_time_days_min: clearable(z.number().int().min(0).max(730)),
  lead_time_days_max: clearable(z.number().int().min(0).max(730)),
  price_note: clearable(z.string().max(500)),
  source: clearable(z.string().max(500)),
  document_id: clearable(z.uuid()),
  status: z.enum(['active', 'discontinued']).optional(),
};

// "column = $n" for each field the caller passed: a value sets it, null clears it, a field
// left out keeps its value. Numbering starts at `first`.
export function setList(columns: Record<string, string>, args: Record<string, unknown>, first: number): { sql: string[]; values: unknown[] } {
  const sql: string[] = [];
  const values: unknown[] = [];
  for (const [arg, column] of Object.entries(columns)) {
    if (args[arg] === undefined) continue;
    values.push(args[arg]);
    sql.push(`${column} = $${first + values.length - 1}`);
  }
  return { sql, values };
}

export async function requireSupplier(tx: pg.PoolClient, id: string): Promise<{ id: string; name: string; status: string }> {
  const r = await tx.query('SELECT id, name, status FROM supplier WHERE id = $1', [id]);
  if (!r.rows[0]) throw new OpError('not_found', 'Supplier not found.');
  return r.rows[0];
}

export type DuplicateMatch = { supplier_id: string; name: string; status: string; matched_on: string[] };

export async function findDuplicates(
  tx: pg.PoolClient,
  q: { name?: string | undefined; website?: string | undefined; email?: string | undefined; phone?: string | undefined; excludeId?: string },
): Promise<DuplicateMatch[]> {
  const found = new Map<string, DuplicateMatch>();
  const add = (row: { id: string; name: string; status: string }, why: string) => {
    if (row.id === q.excludeId) return;
    const m = found.get(row.id) ?? { supplier_id: row.id, name: row.name, status: row.status, matched_on: [] };
    if (!m.matched_on.includes(why)) m.matched_on.push(why);
    found.set(row.id, m);
  };
  const name = q.name ? normName(q.name) : '';
  if (name) {
    const r = await tx.query('SELECT id, name, status FROM supplier WHERE name_norm = $1', [name]);
    for (const row of r.rows) add(row, 'name');
  }
  for (const domain of new Set([companyDomain(q.website), companyDomain(q.email)].filter((d): d is string => Boolean(d)))) {
    const r = await tx.query(
      `SELECT DISTINCT s.id, s.name, s.status FROM supplier s
         LEFT JOIN contact_method m ON m.supplier_id = s.id AND m.type_code = 'email'
        WHERE s.email_domain = $1 OR split_part(m.value_norm, '@', 2) = $1`,
      [domain],
    );
    for (const row of r.rows) add(row, 'domain');
  }
  const tail = q.phone ? phoneTail(q.phone) : '';
  if (tail.length >= 7) {
    const r = await tx.query(
      `SELECT DISTINCT s.id, s.name, s.status FROM supplier s JOIN contact_method m ON m.supplier_id = s.id
        WHERE m.type_code IN ('phone','mobile','sms','whatsapp','fax') AND right(m.value_norm, 8) = $1`,
      [tail],
    );
    for (const row of r.rows) add(row, 'phone');
  }
  return [...found.values()];
}

export async function addMethod(
  tx: pg.PoolClient,
  supplierId: string,
  contactId: string | null,
  m: z.infer<typeof methodSchema>,
): Promise<Record<string, unknown>> {
  if (m.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.value)) {
    throw new OpError('invalid_arguments', `Not an email address: ${m.value}`);
  }
  const norm = normMethodValue(m.type, m.value);
  if (!norm) throw new OpError('invalid_arguments', `Cannot use ${m.value} as a ${m.type}.`);
  if (m.is_preferred) {
    await tx.query('UPDATE contact_method SET is_preferred = false WHERE supplier_id = $1 AND contact_id IS NOT DISTINCT FROM $2', [supplierId, contactId]);
  }
  const r = await tx.query(
    `INSERT INTO contact_method (supplier_id, contact_id, type_code, value, value_norm, label, is_preferred, do_not_contact)
     VALUES ($1, $2, $3, $4, $5, $6, coalesce($7, false), coalesce($8, false))
     ON CONFLICT (company_id, supplier_id, type_code, value_norm) DO UPDATE
       SET contact_id = coalesce(EXCLUDED.contact_id, contact_method.contact_id),
           label = coalesce(EXCLUDED.label, contact_method.label),
           is_preferred = EXCLUDED.is_preferred OR contact_method.is_preferred,
           do_not_contact = EXCLUDED.do_not_contact OR contact_method.do_not_contact,
           removed_at = NULL
     RETURNING id, supplier_id, contact_id, type_code AS type, value, label, is_preferred, do_not_contact`,
    [supplierId, contactId, m.type, m.value, norm, m.label ?? null, m.is_preferred ?? null, m.do_not_contact ?? null],
  );
  return r.rows[0];
}

export async function insertContact(tx: pg.PoolClient, supplierId: string, c: Record<string, any>): Promise<string> {
  if (c.is_primary) await tx.query('UPDATE contact SET is_primary = false WHERE supplier_id = $1', [supplierId]);
  const r = await tx.query(
    `INSERT INTO contact (supplier_id, full_name, job_title, department, is_primary, handles, language, timezone,
                          may_contact_on_behalf, status, notes)
     VALUES ($1, $2, $3, $4, coalesce($5, false), coalesce($6::text[], '{}'), $7, $8, coalesce($9, true), coalesce($10, 'active'), $11)
     RETURNING id`,
    [supplierId, c.full_name, c.job_title ?? null, c.department ?? null, c.is_primary ?? null, c.handles ?? null,
      c.language ?? null, c.timezone ?? null, c.may_contact_on_behalf ?? null, c.status ?? null, c.notes ?? null],
  );
  return r.rows[0].id as string;
}
