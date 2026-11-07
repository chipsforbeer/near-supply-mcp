import { call, type Actor } from './ops.ts';

// A site with a rack, a second rack and a quarantine area.
export async function setupSite(actor: Actor, siteCode = 'MAIN'): Promise<void> {
  await call(actor, 'location_upsert', { site_code: siteCode, site_name: 'Main plant', timezone: 'UTC', code: 'A-01', name: 'Rack A1', kind: 'rack' });
  await call(actor, 'location_upsert', { site_code: siteCode, code: 'B-01', name: 'Rack B1', kind: 'rack' });
  await call(actor, 'location_upsert', { site_code: siteCode, code: 'QC', name: 'Quarantine', kind: 'quarantine' });
}

export async function makeItem(actor: Actor, fields: Record<string, unknown>): Promise<{ id: string; sku: string }> {
  const r = await call(actor, 'item_upsert', {
    category: 'raw_material', physical_form: 'discrete', sourcing_type: 'commodity', base_uom: 'each', ...fields,
  });
  return { id: r.item.id, sku: r.item.sku };
}

export async function solvent(actor: Actor): Promise<{ id: string; sku: string }> {
  const item = await makeItem(actor, { sku: 'SOLV-IPA', name: 'Isopropyl alcohol 99%', category: 'chemical', physical_form: 'liquid', base_uom: 'L' });
  await call(actor, 'item_pack_upsert', { item_id: item.id, name: '200 L drum', contains_qty: 200, container_kind: 'drum' });
  return item;
}
