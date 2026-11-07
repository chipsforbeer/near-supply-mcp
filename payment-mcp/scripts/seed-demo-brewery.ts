// Loads FICTIONAL demo data for a small brewery into an EMPTY company on a supplier-inventory server,
// through the server's normal operations (journaled, with reasons), as the company's owner.
//
// What it creates:
//   - site BREW with dry store, hop cooler, quarantine and fermenter;
//   - six items (malts, Citra hops, ale yeast bricks, CO2) and House IPA with its recipe;
//   - three "Example …" suppliers with prices;
//   - eight weekly brews, which leave yeast, hops and pale malt running low.
// The demo order is 1 yeast brick from Example Yeast Lab at 0.50 USD, paid to SEED_PAYOUT_ACCOUNT.
//
// Guards: you name the company and it must match the key's company; the company must be empty
// (SEED_RESUME=1 continues a run that failed part-way the same UTC day: request keys replay); the key
// must be an owner/approver (setting a payout account needs approve).
//
//   SUPPLY_URL=http://127.0.0.1:8790 SEED_OWNER_KEY=sik_… SEED_COMPANY="Example Brewery" \
//   SEED_PAYOUT_ACCOUNT=<account you control> \
//   node --disable-warning=ExperimentalWarning scripts/seed-demo-brewery.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupplyAuth, TokenFile } from '../src/supply/auth.ts';
import { SupplyClient } from '../src/supply/client.ts';
import { signInHeadless } from '../test/e2e/signin.ts';

const need = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required (see the header of this script).`);
  return v;
};
const base = need('SUPPLY_URL').replace(/\/+$/, '');
const ownerKey = need('SEED_OWNER_KEY');
const company = need('SEED_COMPANY');
const payout = need('SEED_PAYOUT_ACCOUNT');
if (!/^([0-9a-f]{64}|[a-z0-9_-]+(\.[a-z0-9_-]+)*\.(near|testnet))$/.test(payout)) throw new Error(`SEED_PAYOUT_ACCOUNT ${payout} is not a NEAR account id.`);
const resume = process.env.SEED_RESUME === '1';

// Dates are relative to today's UTC midnight, so a resumed run the same day sends identical args.
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const daysAgo = (d: number, hour = 10) => new Date(today.getTime() - d * 86_400_000 + hour * 3_600_000).toISOString();

const dir = mkdtempSync(path.join(os.tmpdir(), 'seed-brewery-'));
const store = new TokenFile(path.join(dir, 'session.json'));
await store.save(await signInHeadless(base, ownerKey, 'read write approve', { allowRemote: true }));
const auth = new SupplyAuth(store, new URL('/mcp', base));
const c = new SupplyClient(new URL(base), auth);
try {
  const me = await c.call<{ company_id: string; company_name: string; scopes: string[] }>('whoami', {}, { reason: 'demo seed: check company' });
  if (me.company_name !== company) throw new Error(`This key signs in to "${me.company_name}", not "${company}". Nothing was changed.`);
  if (!me.scopes.includes('approve')) throw new Error('The key needs approve (owner or approver) to set the payout account. Nothing was changed.');
  const count = async (t: string) => Number((await c.call<{ rows: string[][] }>('sql_query', { sql: `SELECT count(*) FROM ${t}` }, { reason: 'demo seed: is the company empty?' })).rows[0]![0]);
  const existing = (await count('item')) + (await count('supplier')) + (await count('purchase_order'));
  if (existing > 0 && !resume) throw new Error(`"${company}" already has ${existing} items/suppliers/orders: the seed is for an empty company. Nothing was changed.`);

  let n = 0;
  const op = async (name: string, args: Record<string, unknown>): Promise<any> => {
    n += 1;
    return c.call<any>(name, args, { reason: 'fictional demo data (scripts/seed-demo-brewery.ts)', requestKey: `demo-brewery-v1-${me.company_id.slice(0, 8)}-${String(n).padStart(3, '0')}-${name}` });
  };

  for (const loc of [
    { code: 'STORE', name: 'Dry store', kind: 'zone' },
    { code: 'COLD', name: 'Hop cooler', kind: 'zone' },
    { code: 'QC', name: 'Quarantine', kind: 'quarantine' },
    { code: 'FV-1', name: 'Fermenter 1', kind: 'tank' },
  ]) await op('location_upsert', { site_code: 'BREW', site_name: 'Brewhouse', timezone: 'UTC', ...loc });

  const item = async (f: Record<string, unknown>) => (await op('item_upsert', f)).item.id as string;
  const malt = await item({ sku: 'MALT-PALE', name: 'Pale ale malt', category: 'ingredient', physical_form: 'granular', sourcing_type: 'commodity', base_uom: 'kg' });
  await op('item_pack_upsert', { item_id: malt, name: '25 kg sack', contains_qty: 25, container_kind: 'sack' });
  const crystal = await item({ sku: 'MALT-CRYSTAL', name: 'Crystal malt 60L', category: 'ingredient', physical_form: 'granular', sourcing_type: 'commodity', base_uom: 'kg' });
  await op('item_pack_upsert', { item_id: crystal, name: '25 kg sack', contains_qty: 25, container_kind: 'sack' });
  const hops = await item({ sku: 'HOP-CITRA', name: 'Citra hop pellets', category: 'ingredient', physical_form: 'granular', sourcing_type: 'commodity', base_uom: 'kg', is_lot_tracked: true, storage_notes: 'Keep below 4 C' });
  await op('item_pack_upsert', { item_id: hops, name: '5 kg foil pack', contains_qty: 5 });
  const yeast = await item({ sku: 'YEAST-ALE', name: 'Dry ale yeast, 500 g brick', category: 'ingredient', physical_form: 'granular', sourcing_type: 'commodity', base_uom: 'each', storage_notes: 'Refrigerate' });
  const co2 = await item({ sku: 'CO2', name: 'CO2 beverage grade', category: 'ingredient', physical_form: 'gas', sourcing_type: 'commodity', base_uom: 'kg' });
  await op('item_pack_upsert', { item_id: co2, name: '30 kg cylinder', contains_qty: 30, container_name: 'Gas cylinder' });
  const ipa = await item({ sku: 'IPA-BULK', name: 'House IPA (bulk)', category: 'finished_good', physical_form: 'liquid', sourcing_type: 'made_to_print', base_uom: 'L', is_lot_tracked: true });

  await op('bom_upsert', { output_item_id: ipa, batch_qty: 1000, expected_yield: 0.9,
    lines: [{ item_id: malt, qty: 220 }, { item_id: crystal, qty: 15 }, { item_id: hops, qty: 6 }, { item_id: yeast, qty: 2 }, { item_id: co2, qty: 10 }] });

  const imported = await op('supplier_import', { suppliers: [
    { name: 'Example Maltings Co.', website: 'https://maltings.example.com', supplier_type: 'manufacturer', currency: 'USD',
      contacts: [{ full_name: 'Robin Example', handles: ['quotes', 'orders'], methods: [{ type: 'email', value: 'orders@maltings.example.com', is_preferred: true }] }] },
    { name: 'Example Hop Merchants', website: 'https://hops.example.com', supplier_type: 'distributor', currency: 'USD',
      contacts: [{ full_name: 'Casey Example', handles: ['quotes'], methods: [{ type: 'email', value: 'sales@hops.example.com', is_preferred: true }] }] },
    { name: 'Example Yeast Lab', website: 'https://yeastlab.example.com', supplier_type: 'manufacturer', currency: 'USD',
      contacts: [{ full_name: 'Sam Example', handles: ['quotes', 'orders'], methods: [{ type: 'email', value: 'orders@yeastlab.example.com', is_preferred: true }] }] },
  ] });
  const [maltster, hopco, yeastlab] = imported.results.map((r: any) => r.supplier_id as string);
  await op('supplier_item_upsert', { supplier_id: maltster, item_id: malt, purchase_pack: '25 kg sack', moq: 1, lead_time_days: 10, last_price: '0.95', last_price_per: 'base', last_price_currency: 'USD', is_preferred: true });
  await op('supplier_item_upsert', { supplier_id: maltster, item_id: crystal, purchase_pack: '25 kg sack', moq: 1, lead_time_days: 10, last_price: '1.40', last_price_per: 'base', last_price_currency: 'USD', is_preferred: true });
  await op('supplier_item_upsert', { supplier_id: hopco, item_id: hops, purchase_pack: '5 kg foil pack', moq: 1, lead_time_days: 7, last_price: '18.00', last_price_per: 'base', last_price_currency: 'USD', is_preferred: true });
  await op('supplier_item_upsert', { supplier_id: yeastlab, item_id: yeast, moq: 1, lead_time_days: 3, last_price: '0.50', last_price_per: 'base', last_price_currency: 'USD', is_preferred: true });
  await op('supplier_payout_account_set', { supplier_id: yeastlab, network: 'near', account_id: payout, token: 'usdc', note: 'demo payout account controlled by the developer' });

  await op('reorder_policy_set', { item_id: malt, site_code: 'BREW', method: 'days_of_cover', safety_days: 5, target_cover_days: 30 });
  await op('reorder_policy_set', { item_id: yeast, site_code: 'BREW', method: 'days_of_cover', safety_days: 7, target_cover_days: 21 });

  const at = (loc: string) => ({ site_code: 'BREW', location_code: loc, occurred_at: daysAgo(60) });
  await op('stock_move', { item_id: malt, type: 'opening_balance', qty: 2200, ...at('STORE') });
  await op('stock_move', { item_id: crystal, type: 'opening_balance', qty: 200, ...at('STORE') });
  await op('stock_move', { item_id: hops, type: 'opening_balance', qty: 30, ...at('COLD'), lot_code: 'CT-25A', expires_on: daysAgo(-300).slice(0, 10) });
  await op('stock_move', { item_id: hops, type: 'opening_balance', qty: 25, ...at('COLD'), lot_code: 'CT-25B', expires_on: daysAgo(-420).slice(0, 10) });
  await op('stock_move', { item_id: yeast, type: 'opening_balance', qty: 18, ...at('COLD') });
  await op('stock_move', { item_id: co2, type: 'opening_balance', qty: 6, pack: '30 kg cylinder', ...at('STORE') });

  // Eight weekly 1,000 L brews. On brew day, that brew's hops and yeast move from the cooler to the store.
  let b = 0;
  for (let d = 52; d >= 3; d -= 7) {
    b += 1;
    const pull = { site_code: 'BREW', location_code: 'COLD', to_location_code: 'STORE', occurred_at: daysAgo(d, 8) };
    await op('stock_move', { item_id: hops, type: 'transfer', qty: 6, lot_code: b <= 5 ? 'CT-25A' : 'CT-25B', ...pull });
    await op('stock_move', { item_id: yeast, type: 'transfer', qty: 2, ...pull });
    await op('production_run_record', { output_item_id: ipa, run_code: `IPA-${200 + b}`, site_code: 'BREW', consume_location_code: 'STORE', output_location_code: 'FV-1', actual_output_qty: 1000, finished_at: daysAgo(d, 15) });
  }
  console.error(`Seeded "${company}": ${n} operations. Left: pale malt 440 kg, Citra 7 kg, yeast 2 bricks. Demo order: 1 yeast brick from Example Yeast Lab (0.50 USD) → ${payout}.`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await auth.revoke().catch(() => false); // end the owner session at the server
  rmSync(dir, { recursive: true, force: true });
}
