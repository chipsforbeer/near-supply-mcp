import type pg from 'pg';
import { OpError } from '../errors.ts';

export const CATEGORIES = ['raw_material', 'ingredient', 'packaging', 'component', 'wip', 'finished_good',
  'consumable', 'mro_spare', 'chemical', 'tooling', 'other'] as const;
export const PHYSICAL_FORMS = ['discrete', 'powder', 'granular', 'liquid', 'gas', 'paste', 'sheet',
  'bar_profile', 'coil', 'roll_goods'] as const;
export const SOURCING_TYPES = ['commodity', 'catalog', 'made_to_print', 'service'] as const;
export const ITEM_STATUSES = ['active', 'phase_out', 'obsolete'] as const;
export const IDENTIFIER_KINDS = ['mpn', 'cas', 'drawing', 'standard', 'hs_code', 'gtin', 'alias'] as const;
export const CONTAINER_KINDS = ['drum', 'ibc', 'sack', 'bulk_bag', 'box', 'case', 'carton', 'pallet', 'bottle',
  'can', 'keg', 'cylinder', 'pail', 'jerrycan', 'roll', 'spool', 'reel', 'tote', 'bulk', 'other'] as const;
export const LOCATION_KINDS = ['zone', 'rack', 'bin', 'tank', 'silo', 'cold_room', 'line', 'receiving',
  'quarantine', 'in_transit', 'shipping', 'yard'] as const;

export async function requireItem(tx: pg.PoolClient, itemId: string): Promise<{ id: string; sku: string; name: string; base_uom: string; is_lot_tracked: boolean }> {
  const r = await tx.query('SELECT id, sku, name, base_uom, is_lot_tracked FROM item WHERE id = $1', [itemId]);
  if (!r.rows[0]) throw new OpError('not_found', 'Item not found.');
  return r.rows[0];
}

export async function requireSite(tx: pg.PoolClient, code: string): Promise<{ id: string; code: string; timezone: string }> {
  const r = await tx.query('SELECT id, code, timezone FROM site WHERE code = $1', [code]);
  if (!r.rows[0]) throw new OpError('not_found', `No site with code ${code}.`);
  return r.rows[0];
}

export async function requireLocation(
  tx: pg.PoolClient,
  siteCode: string,
  locationCode: string,
): Promise<{ id: string; code: string; kind: string; site_id: string; site_code: string }> {
  const r = await tx.query(
    `SELECT l.id, l.code, l.kind, l.site_id, s.code AS site_code
       FROM location l JOIN site s ON s.id = l.site_id
      WHERE s.code = $1 AND l.code = $2`,
    [siteCode, locationCode],
  );
  if (!r.rows[0]) throw new OpError('not_found', `No location ${locationCode} at site ${siteCode}.`);
  return r.rows[0];
}

export async function requireUom(tx: pg.PoolClient, code: string): Promise<{ code: string; dimension: string }> {
  const r = await tx.query('SELECT code, dimension FROM uom WHERE code = $1', [code]);
  if (!r.rows[0]) throw new OpError('invalid_arguments', `Unknown unit ${code}. Units: each, g, kg, t, lb, mL, L, m3, gal_us, mm, m, in, ft, m2 and more.`);
  return r.rows[0];
}

export async function brandIdFor(tx: pg.PoolClient, name: string | undefined): Promise<string | null> {
  if (!name) return null;
  const r = await tx.query(
    `INSERT INTO brand (name) VALUES ($1)
     ON CONFLICT (company_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name.trim()],
  );
  return r.rows[0].id as string;
}
