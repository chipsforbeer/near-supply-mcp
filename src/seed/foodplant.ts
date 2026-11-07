import { daysAgo, type SeedRunner } from './runner.ts';

// Lark Hill Foods (fictional): a small brewery. Pale malt sits just below its reorder point.
export async function seedFoodplant(r: SeedRunner): Promise<{ maltId: string }> {
  for (const loc of [
    { code: 'STORE', name: 'Brewhouse store', kind: 'zone' },
    { code: 'QC', name: 'Quarantine', kind: 'quarantine' },
    { code: 'TANK-1', name: 'Bright tank 1', kind: 'tank' },
  ]) {
    await r.op('location_upsert', { site_code: 'BREW', site_name: 'Brewhouse', timezone: 'UTC', ...loc });
  }
  const item = async (f: Record<string, unknown>) => (await r.op('item_upsert', f)).item.id as string;
  const malt = await item({ sku: 'MALT-PALE', name: 'Pale malt', category: 'ingredient', physical_form: 'granular', sourcing_type: 'commodity', base_uom: 'kg' });
  await r.op('item_pack_upsert', { item_id: malt, name: '25 kg sack', contains_qty: 25, container_kind: 'sack' });
  await r.op('item_pack_upsert', { item_id: malt, name: 'pallet of 40 sacks', contains_qty: 40, contains_pack: '25 kg sack', container_kind: 'pallet' });
  const hops = await item({ sku: 'HOP-CITRA', name: 'Citra hop pellets', category: 'ingredient', physical_form: 'granular', sourcing_type: 'commodity', base_uom: 'kg', is_lot_tracked: true, storage_notes: 'Keep below 4 C' });
  await r.op('item_pack_upsert', { item_id: hops, name: '5 kg foil pack', contains_qty: 5 });
  const co2 = await item({ sku: 'CO2', name: 'CO2 beverage grade', category: 'ingredient', physical_form: 'gas', sourcing_type: 'commodity', base_uom: 'kg' });
  await r.op('item_pack_upsert', { item_id: co2, name: '30 kg cylinder', contains_qty: 30, container_name: 'Gas cylinder' });
  const caustic = await item({ sku: 'NAOH-50', name: 'Caustic soda 50%', category: 'chemical', physical_form: 'liquid', sourcing_type: 'commodity', base_uom: 'L', hazmat_class: 'UN 1824 class 8' });
  await r.op('item_pack_upsert', { item_id: caustic, name: '25 L jerrycan', contains_qty: 25, container_kind: 'jerrycan' });
  await r.op('item_conversion_set', { item_id: caustic, from_uom: 'L', to_uom: 'kg', factor: '1.52' });
  await r.op('item_identifier_add', { item_id: caustic, kind: 'cas', value: '1310-73-2' });
  const lager = await item({ sku: 'LAGER-BULK', name: 'Lager (bulk)', category: 'finished_good', physical_form: 'liquid', sourcing_type: 'made_to_print', base_uom: 'L', is_lot_tracked: true });

  await r.op('bom_upsert', {
    output_item_id: lager, batch_qty: 2000, expected_yield: 0.92,
    lines: [
      { item_id: malt, qty: 400 },
      { item_id: hops, qty: 4 },
      { item_id: co2, qty: 20 },
      { item_id: caustic, qty: 5, scales_with_batch: false },
    ],
  });
  await r.op('spec_upsert', { item_id: malt, body_md: 'Moisture max 4.5 %. Colour 3.0-4.5 EBC. Extract min 80 % (fine grind, dry basis). Certificate of analysis with every lot.' });

  const imported = await r.op('supplier_import', {
    suppliers: [
      { name: 'Example Maltings North', website: 'https://maltings-north.example.com', supplier_type: 'manufacturer', currency: 'USD',
        contacts: [{ full_name: 'Robin Example', handles: ['quotes', 'orders'], methods: [{ type: 'email', value: 'orders@maltings-north.example.com', is_preferred: true }] }] },
      { name: 'Example Grain Traders', website: 'https://grain-traders.example.com', supplier_type: 'trader', currency: 'USD',
        contacts: [{ full_name: 'Casey Example', handles: ['quotes'], methods: [{ type: 'email', value: 'quotes@grain-traders.example.com', is_preferred: true }] }] },
      { name: 'Example Hop Merchants', website: 'https://hop-merchants.example.com', supplier_type: 'distributor', currency: 'USD' },
    ],
  });
  const maltsterId = imported.results[0].supplier_id as string;
  await r.op('supplier_item_upsert', { supplier_id: maltsterId, item_id: malt, purchase_pack: '25 kg sack', moq: 1, moq_pack: 'pallet of 40 sacks', lead_time_days: 10, last_price: '0.95', last_price_per: 'base', last_price_currency: 'USD', is_preferred: true });
  await r.op('reorder_policy_set', { item_id: malt, site_code: 'BREW', method: 'days_of_cover', safety_days: 5, target_cover_days: 30 });

  const at = { site_code: 'BREW', location_code: 'STORE', occurred_at: daysAgo(80) };
  await r.op('stock_move', { item_id: malt, type: 'opening_balance', qty: 4700, ...at });
  await r.op('stock_move', { item_id: hops, type: 'opening_balance', qty: 25, ...at, lot_code: 'HC-23A', expires_on: daysAgo(-120).slice(0, 10) });
  await r.op('stock_move', { item_id: hops, type: 'opening_balance', qty: 25, ...at, lot_code: 'HC-24B', expires_on: daysAgo(-500).slice(0, 10) });
  await r.op('stock_move', { item_id: co2, type: 'opening_balance', qty: 10, pack: '30 kg cylinder', ...at });
  await r.op('stock_move', { item_id: caustic, type: 'opening_balance', qty: 4, pack: '25 L jerrycan', ...at });

  // Ten weekly brews of 2,000 L: about 53 kg of malt a day over the last 30 days.
  let n = 0;
  for (let d = 66; d >= 3; d -= 7) {
    n += 1;
    await r.op('production_run_record', {
      output_item_id: lager, run_code: `B${100 + n}`, site_code: 'BREW', consume_location_code: 'STORE', output_location_code: 'TANK-1',
      actual_output_qty: 2000, finished_at: daysAgo(d, 15),
    });
  }
  return { maltId: malt };
}
