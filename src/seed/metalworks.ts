import { daysAgo, type SeedRunner } from './runner.ts';

// Northbeck Metalworks (fictional): a small shop making powder-coated steel enclosures.
// Stainless sheet ends up below its reorder point, which is where the demo starts.
export async function seedMetalworks(r: SeedRunner): Promise<{ sheetId: string; stockholderId: string }> {
  for (const loc of [
    { code: 'RCV', name: 'Receiving dock', kind: 'receiving' },
    { code: 'A-01', name: 'Sheet rack A1', kind: 'rack' },
    { code: 'B-01', name: 'Parts rack B1', kind: 'rack' },
    { code: 'QC', name: 'Quarantine cage', kind: 'quarantine' },
    { code: 'LINE-1', name: 'Fabrication line 1', kind: 'line' },
    { code: 'FG', name: 'Finished goods', kind: 'zone' },
  ]) {
    await r.op('location_upsert', { site_code: 'MAIN', site_name: 'Main works', timezone: 'UTC', ...loc });
  }

  const item = async (f: Record<string, unknown>) => (await r.op('item_upsert', f)).item.id as string;
  const sheet = await item({ sku: 'SS304-1.5', name: '304 stainless sheet 1.5 mm 2B', category: 'raw_material', physical_form: 'sheet', sourcing_type: 'commodity', base_uom: 'kg', is_lot_tracked: true, storage_notes: 'Keep dry, interleaved' });
  await r.op('item_pack_upsert', { item_id: sheet, name: 'sheet 1219x2438', contains_qty: '35.4' });
  await r.op('item_pack_upsert', { item_id: sheet, name: 'bundle of 20 sheets', contains_qty: 20, contains_pack: 'sheet 1219x2438', container_kind: 'pallet' });
  await r.op('item_identifier_add', { item_id: sheet, kind: 'standard', value: 'ASTM A240 304', is_primary: true });
  await r.op('item_identifier_add', { item_id: sheet, kind: 'hs_code', value: '7219.33' });

  const bolt = await item({ sku: 'BOLT-M6x16', name: 'M6x16 A2 hex bolt', category: 'component', physical_form: 'discrete', sourcing_type: 'catalog', base_uom: 'each' });
  await r.op('item_pack_upsert', { item_id: bolt, name: 'box of 200', contains_qty: 200, container_kind: 'box' });
  await r.op('item_identifier_add', { item_id: bolt, kind: 'standard', value: 'ISO 4017 M6x16 A2-70' });
  const powder = await item({ sku: 'PWD-7035', name: 'Powder coat RAL 7035 semi-gloss', category: 'raw_material', physical_form: 'powder', sourcing_type: 'commodity', base_uom: 'kg', is_lot_tracked: true, shelf_life_days: 365 });
  await r.op('item_pack_upsert', { item_id: powder, name: '20 kg box', contains_qty: 20, container_kind: 'box' });
  const gasket = await item({ sku: 'GSK-EPDM10', name: 'EPDM door gasket 10 mm', category: 'component', physical_form: 'roll_goods', sourcing_type: 'catalog', base_uom: 'm' });
  await r.op('item_pack_upsert', { item_id: gasket, name: 'roll of 50 m', contains_qty: 50, container_kind: 'roll' });
  const hinge = await item({ sku: 'HNG-200', name: 'Stainless hinge H-200', category: 'component', physical_form: 'discrete', sourcing_type: 'catalog', base_uom: 'each' });
  await r.op('item_identifier_add', { item_id: hinge, kind: 'mpn', value: 'H-200', manufacturer: 'Example Hinge Works' });
  const bracket = await item({ sku: 'BRK-104', name: 'Mounting bracket BRK-104 rev C', category: 'component', physical_form: 'discrete', sourcing_type: 'made_to_print', base_uom: 'each' });
  await r.op('item_identifier_add', { item_id: bracket, kind: 'drawing', value: 'BRK-104', revision: 'C' });
  const enclosure = await item({ sku: 'ENC-400', name: 'Enclosure 400x300x200 RAL 7035', category: 'finished_good', physical_form: 'discrete', sourcing_type: 'made_to_print', base_uom: 'each' });
  await r.op('item_pack_upsert', { item_id: enclosure, name: 'pallet of 12', contains_qty: 12, container_kind: 'pallet' });

  await r.op('bom_upsert', {
    output_item_id: enclosure, batch_qty: 1, notes: 'Per enclosure; sheet includes 12% nesting offcuts.',
    lines: [
      { item_id: sheet, qty: '9.8', scrap_factor: 0.12 },
      { item_id: bolt, qty: 12 },
      { item_id: powder, qty: '0.35' },
      { item_id: gasket, qty: '1.4' },
      { item_id: hinge, qty: 2 },
      { item_id: bracket, qty: 2 },
    ],
  });

  const { document_id: specSheet } = await r.op('document_add', {
    kind: 'spec_sheet', title: 'SS304-1.5 purchasing specification', location: 'C:\\Purchasing\\Specs\\SS304-1.5 purchasing specification.pdf',
    text: ['Northbeck Metalworks - purchasing specification', 'Item: SS304-1.5 stainless sheet', 'Grade: 304 (304/304L dual certified accepted)',
      'Thickness: 1.5 mm +/- 0.08 mm', 'Finish: 2B', 'Size: 1219 x 2438 mm', 'Certificate: EN 10204 3.1 mill certificate with every heat'].join('\n'),
    links: [{ entity_type: 'item', entity_id: sheet, role: 'our spec' }],
  });
  await r.op('spec_upsert', {
    item_id: sheet,
    body_md: 'Grade 304 (304/304L dual certified accepted). Thickness 1.5 mm +/- 0.08 mm. Finish 2B. Sheet 1219 x 2438 mm. EN 10204 3.1 mill certificate with every heat.',
    document_ids: [specSheet],
  });
  await r.op('spec_upsert', { item_id: powder, body_md: 'RAL 7035, semi-gloss 60-70 GU, polyester for indoor/outdoor, cure 10 min at 180 C. Batch certificate required.' });

  const imported = await r.op('supplier_import', {
    suppliers: [
      {
        name: 'Example Stainless Stockholders', legal_name: 'Example Stainless Stockholders Ltd', website: 'https://stainless-stock.example.com',
        supplier_type: 'distributor', country_code: 'GB', tax_id: 'EX-VAT-1001', registration_number: 'EX-REG-1001',
        capabilities: ['sheet_cutting'], currency: 'USD', payment_terms: '30 days', incoterms: 'DAP',
        addresses: [{ kind: 'warehouse', lines: 'Unit 4, Example Trading Estate', city: 'Example City', postal_code: 'EX1 1AA', country_code: 'GB' }],
        methods: [{ type: 'email', value: 'info@stainless-stock.example.com' }, { type: 'phone', value: '+44 20 7946 0100' }],
        contacts: [{ full_name: 'Sam Example', job_title: 'Sales manager', handles: ['quotes', 'orders'], language: 'en',
          methods: [{ type: 'email', value: 'sales@stainless-stock.example.com', is_preferred: true }, { type: 'phone', value: '+44 20 7946 0101' }] }],
        offerings: [
          { kind: 'product', category: 'Stainless sheet and plate', description: '304/304L and 316L, 0.5 to 6 mm, 2B and No. 4 finishes, full sheets or cut to size',
            tags: ['stainless', 'sheet', 'plate'], min_order: '1 bundle', lead_time_days_min: 5, lead_time_days_max: 10, source: 'https://stainless-stock.example.com/products' },
          { kind: 'service', category: 'Sheet cutting', description: 'Guillotine and laser cutting to size, up to 6 mm', tags: ['cutting'], lead_time_days_min: 2, lead_time_days_max: 5 },
        ],
      },
      {
        name: 'Example Fasteners', website: 'https://fasteners.example.com', supplier_type: 'distributor', country_code: 'GB', currency: 'USD',
        contacts: [{ full_name: 'Alex Example', handles: ['quotes', 'orders'], methods: [{ type: 'email', value: 'orders@fasteners.example.com', is_preferred: true }] }],
        offerings: [{ kind: 'product', category: 'Stainless fasteners', description: 'A2 and A4 bolts, nuts and washers, M3 to M20', tags: ['fasteners', 'bolts'] }],
      },
      {
        name: 'Example Coatings', website: 'https://coatings.example.com', supplier_type: 'manufacturer', country_code: 'GB', capabilities: ['powder_coating'], currency: 'USD',
        contacts: [{ full_name: 'Jordan Example', handles: ['quotes', 'quality'], methods: [{ type: 'email', value: 'quality@coatings.example.com', is_preferred: true }] }],
        offerings: [
          { kind: 'service', category: 'Powder coating', description: 'RAL colours, polyester and epoxy, parts up to 2 m', tags: ['powder', 'coating'] },
          { kind: 'product', category: 'Powder coat', description: 'RAL 7035 and other stock colours in 20 kg boxes', tags: ['powder'] },
        ],
      },
    ],
  });
  const [stockholderId, fastenersId, coatingsId] = imported.results.map((x: { supplier_id: string }) => x.supplier_id) as [string, string, string];
  await r.op('supplier_item_upsert', { supplier_id: stockholderId, item_id: sheet, purchase_pack: 'bundle of 20 sheets', moq: 1, moq_pack: 'bundle of 20 sheets', lead_time_days: 10, last_price: '3.05', last_price_per: 'base', last_price_currency: 'USD', is_preferred: true });
  await r.op('supplier_item_upsert', { supplier_id: fastenersId, item_id: bolt, purchase_pack: 'box of 200', lead_time_days: 5, is_preferred: true });
  await r.op('supplier_item_upsert', { supplier_id: coatingsId, item_id: powder, purchase_pack: '20 kg box', lead_time_days: 7, is_preferred: true });

  await r.op('reorder_policy_set', { item_id: sheet, site_code: 'MAIN', method: 'days_of_cover', safety_days: 5, target_cover_days: 30 });
  await r.op('reorder_policy_set', { item_id: bolt, site_code: 'MAIN', method: 'min_max', min_qty: 1000, max_qty: 4000 });
  await r.op('reorder_policy_set', { item_id: powder, site_code: 'MAIN', method: 'days_of_cover', safety_days: 7, target_cover_days: 45 });

  const at = { site_code: 'MAIN', location_code: 'A-01' };
  await r.op('stock_move', { item_id: sheet, type: 'opening_balance', qty: 2000, ...at, lot_code: 'HEAT-1001', occurred_at: daysAgo(90) });
  await r.op('stock_move', { item_id: sheet, type: 'receipt', qty: 3, pack: 'bundle of 20 sheets', ...at, lot_code: 'HEAT-1002', occurred_at: daysAgo(40) });
  await r.op('stock_move', { item_id: bolt, type: 'opening_balance', qty: 5000, ...at, occurred_at: daysAgo(90) });
  await r.op('stock_move', { item_id: powder, type: 'opening_balance', qty: 200, ...at, lot_code: 'PC-2210', expires_on: daysAgo(-300).slice(0, 10), occurred_at: daysAgo(90) });
  await r.op('stock_move', { item_id: gasket, type: 'opening_balance', qty: 12, pack: 'roll of 50 m', ...at, occurred_at: daysAgo(90) });
  await r.op('stock_move', { item_id: hinge, type: 'opening_balance', qty: 800, ...at, occurred_at: daysAgo(90) });
  await r.op('stock_move', { item_id: bracket, type: 'opening_balance', qty: 800, ...at, occurred_at: daysAgo(90) });

  // Sixty days of production: 11 enclosures every other day, about 60 kg of sheet a day.
  let n = 0;
  for (let d = 59; d >= 1; d -= 2) {
    n += 1;
    await r.op('production_run_record', {
      output_item_id: enclosure, run_code: `WO-${String(n).padStart(4, '0')}`, site_code: 'MAIN',
      consume_location_code: 'A-01', output_location_code: 'FG', actual_output_qty: 11, finished_at: daysAgo(d, 16),
    });
  }

  await r.op('wiki_create', {
    path: 'suppliers/example-stainless-stockholders.md', entity_type: 'supplier', entity_id: stockholderId,
    body_md: `# Example Stainless Stockholders\n\n## Summary\nMain source of 304 sheet. Sells by the bundle of 20 sheets; 10 days lead time.\n\n## Contacts\nSam Example (sales) for quotes and orders.\n\n## Timeline\n- Opening relationship: existing supplier.\n\n## Offers and verdicts\nLast price 3.05 USD/kg.\n\n## Open issues\nNone.\n`,
  });
  await r.op('wiki_append', { path: 'rules.md', text: '- Stainless sheet: always ask for EN 10204 3.1 mill certificates; no certificate, no order.\n' });
  await r.op('wiki_replace', {
    path: 'index.md', old_text: '- [[log]]: one line per event, newest last\n',
    new_text: '- [[log]]: one line per event, newest last\n- [Example Stainless Stockholders](suppliers/example-stainless-stockholders.md): main 304 sheet supplier\n',
  });
  return { sheetId: sheet, stockholderId };
}
