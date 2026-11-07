import type pg from 'pg';
import { OpError } from '../errors.ts';
import { companyDomain, normName } from '../../domain/normalize.ts';
import { findDuplicates, setList } from './common.ts';

type Opt<T> = T | null | undefined;

export type SupplierInput = {
  supplier_id?: string | undefined;
  name?: string | undefined;
  legal_name?: Opt<string>;
  website?: Opt<string>;
  email_domain?: Opt<string>;
  country_code?: Opt<string>;
  supplier_type?: Opt<string>;
  capabilities?: string[] | undefined;
  currency?: Opt<string>;
  payment_terms?: Opt<string>;
  incoterms?: Opt<string>;
  origin?: 'existing' | 'discovered' | undefined;
  discovered_for_rfq?: Opt<string>;
  discovery_sources?: string[] | undefined;
  status?: string | undefined;
  tags?: string[] | undefined;
  rating?: Opt<number>;
  notes?: Opt<string>;
  tax_id?: Opt<string>;
  registration_number?: Opt<string>;
  addresses?: { kind: string; lines: string; city?: string | undefined; region?: string | undefined; postal_code?: string | undefined; country_code?: string | undefined }[] | undefined;
  allow_similar?: boolean | undefined;
};

// Argument name -> column, for updates.
const COLUMNS: Record<string, string> = {
  name: 'name', name_norm: 'name_norm', legal_name: 'legal_name', website: 'website', email_domain_norm: 'email_domain',
  country_code: 'country_code', supplier_type: 'supplier_type', capabilities: 'capabilities', currency: 'default_currency',
  payment_terms: 'payment_terms', incoterms: 'default_incoterms', origin: 'origin', discovered_for_rfq: 'discovered_for_rfq',
  discovery_sources: 'discovery_sources', status: 'status', tags: 'tags', rating: 'rating', notes: 'notes', tax_id: 'tax_id',
  registration_number: 'registration_number',
};

async function checkRfq(tx: pg.PoolClient, id: Opt<string>): Promise<void> {
  if (!id) return;
  const rfq = await tx.query('SELECT 1 FROM rfq WHERE id = $1', [id]);
  if (!rfq.rowCount) throw new OpError('not_found', 'discovered_for_rfq does not match an RFQ.');
}

// Creates a supplier (refusing likely duplicates unless allow_similar) or updates one by id.
// On update, a field left out keeps its value and null clears it.
export async function saveSupplier(tx: pg.PoolClient, s: SupplierInput): Promise<{ created: boolean; supplier: Record<string, any> }> {
  let row: Record<string, any>;
  let created: boolean;
  await checkRfq(tx, s.discovered_for_rfq);
  if (!s.supplier_id) {
    if (!s.name || !s.origin) throw new OpError('invalid_arguments', 'New suppliers need name and origin (existing or discovered).');
    if (!s.allow_similar) {
      const matches = await findDuplicates(tx, { name: s.name, website: s.website ?? undefined, email: s.email_domain ? `x@${s.email_domain}` : undefined });
      if (matches.length) {
        throw new OpError('conflict', 'A similar supplier already exists; update it, or pass allow_similar: true if this is a different company.', { matches });
      }
    }
    const domain = s.email_domain ? companyDomain(s.email_domain) : companyDomain(s.website ?? undefined);
    const status = s.status ?? (s.origin === 'existing' ? 'approved' : 'prospect');
    const r = await tx.query(
      `INSERT INTO supplier (name, name_norm, legal_name, website, email_domain, country_code, supplier_type, capabilities,
                             default_currency, payment_terms, default_incoterms, origin, discovered_for_rfq, discovery_sources,
                             status, tags, rating, notes, tax_id, registration_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8::text[], '{}'), $9, $10, $11, $12, $13, coalesce($14::text[], '{}'), $15, coalesce($16::text[], '{}'), $17, $18, $19, $20)
       RETURNING *`,
      [s.name, normName(s.name), s.legal_name ?? null, s.website ?? null, domain, s.country_code ?? null, s.supplier_type ?? null,
        s.capabilities ?? null, s.currency ?? null, s.payment_terms ?? null, s.incoterms ?? null, s.origin, s.discovered_for_rfq ?? null,
        s.discovery_sources ?? null, status, s.tags ?? null, s.rating ?? null, s.notes ?? null, s.tax_id ?? null, s.registration_number ?? null],
    );
    row = r.rows[0];
    created = true;
  } else {
    const fields: Record<string, unknown> = { ...s };
    if (s.name !== undefined) fields.name_norm = normName(s.name);
    // The company email domain follows an explicit email_domain, else a new website.
    if (s.email_domain !== undefined) fields.email_domain_norm = s.email_domain === null ? null : companyDomain(s.email_domain);
    else if (typeof s.website === 'string') fields.email_domain_norm = companyDomain(s.website);
    const set = setList(COLUMNS, fields, 2);
    const r = await tx.query(
      `UPDATE supplier SET ${[...set.sql, 'updated_at = now()'].join(', ')} WHERE id = $1 RETURNING *`,
      [s.supplier_id, ...set.values],
    );
    if (!r.rows[0]) throw new OpError('not_found', 'Supplier not found.');
    row = r.rows[0];
    created = false;
  }
  if (s.addresses) {
    await tx.query('DELETE FROM supplier_address WHERE supplier_id = $1', [row.id]);
    for (const a of s.addresses) {
      await tx.query(
        `INSERT INTO supplier_address (supplier_id, kind, lines, city, region, postal_code, country_code) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.id, a.kind, a.lines, a.city ?? null, a.region ?? null, a.postal_code ?? null, a.country_code ?? null],
      );
    }
  }
  const { company_id: _c, name_norm: _n, ...supplier } = row;
  return { created, supplier };
}
