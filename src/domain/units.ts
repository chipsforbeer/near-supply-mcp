import type pg from 'pg';
import { OpError } from '../ops/errors.ts';
import { dec, div, floorCount, mul, str, sub, times, type Dec } from './decimal.ts';
import { sequential } from '../db/pool.ts';

export type UomInfo = { dimension: string; toSi: string };
export type PackInfo = { id: string; name: string; baseQty: string };
export type ItemUnits = {
  baseUom: string;
  uoms: Map<string, UomInfo>;
  conversions: { from: string; to: string; factor: string }[];
  packs: PackInfo[];
};
export type UnitSpec = { uom?: string | undefined; pack?: string | undefined };

function uomOf(item: ItemUnits, code: string): UomInfo {
  const u = item.uoms.get(code);
  if (!u) throw new OpError('invalid_arguments', `Unknown unit: ${code}.`);
  return u;
}

// Converts a quantity in `from` to `to` when both share a dimension.
function sameDimension(qty: Dec, from: string, to: string, item: ItemUnits): Dec {
  if (from === to) return qty;
  return div(mul(qty, dec(uomOf(item, from).toSi)), dec(uomOf(item, to).toSi));
}

export function findPack(item: ItemUnits, pack: string): PackInfo {
  const wanted = pack.trim().toLowerCase();
  const found = item.packs.find((p) => p.id === pack || p.name.toLowerCase() === wanted);
  if (!found) {
    const names = item.packs.map((p) => p.name).join(', ') || 'none defined';
    throw new OpError('invalid_arguments', `Unknown pack "${pack}" for this item (packs: ${names}).`);
  }
  return found;
}

// "3 drums", "40 kg", "2 pallets" -> base units of the item. Impossible conversions are errors, never guesses.
export function toBase(qty: string, unit: UnitSpec, item: ItemUnits): string {
  const q = dec(qty);
  if (unit.uom && unit.pack) throw new OpError('invalid_arguments', 'Give either uom or pack, not both.');
  if (unit.pack) return str(mul(q, dec(findPack(item, unit.pack).baseQty)));
  if (!unit.uom || unit.uom === item.baseUom) return str(q);
  const from = uomOf(item, unit.uom);
  const base = uomOf(item, item.baseUom);
  if (from.dimension === base.dimension) return str(sameDimension(q, unit.uom, item.baseUom, item));
  for (const c of item.conversions) {
    const cf = uomOf(item, c.from);
    const ct = uomOf(item, c.to);
    if (cf.dimension === from.dimension && ct.dimension === base.dimension) {
      const inFrom = sameDimension(q, unit.uom, c.from, item);
      return str(sameDimension(mul(inFrom, dec(c.factor)), c.to, item.baseUom, item));
    }
    if (ct.dimension === from.dimension && cf.dimension === base.dimension) {
      const inTo = sameDimension(q, unit.uom, c.to, item);
      return str(sameDimension(div(inTo, dec(c.factor)), c.from, item.baseUom, item));
    }
  }
  throw new OpError(
    'invalid_arguments',
    `Cannot convert ${unit.uom} to ${item.baseUom} for this item; record a conversion with item_conversion_set first.`,
  );
}

// 720 L with a 200 L drum pack -> "3 x 200 L drum + 120 L". Largest packs first.
export function describeInPacks(qtyBase: string, packs: PackInfo[], baseUom: string): string {
  let rest = dec(qtyBase);
  if (rest <= 0n) return `${str(rest)} ${baseUom}`;
  const parts: string[] = [];
  const sorted = [...packs].sort((a, b) => (dec(b.baseQty) > dec(a.baseQty) ? 1 : -1));
  for (const p of sorted) {
    const size = dec(p.baseQty);
    const n = floorCount(rest, size);
    if (n > 0n) {
      parts.push(`${n} x ${p.name}`);
      rest = sub(rest, times(size, n));
    }
  }
  if (rest > 0n || parts.length === 0) parts.push(`${str(rest)} ${baseUom}`);
  return parts.join(' + ');
}

export async function loadItemUnits(tx: pg.PoolClient, itemId: string): Promise<ItemUnits> {
  const item = await tx.query('SELECT base_uom FROM item WHERE id = $1', [itemId]);
  if (!item.rows[0]) throw new OpError('not_found', 'Item not found.');
  const [uoms, conversions, packs] = await sequential([
    () => tx.query('SELECT code, dimension, to_si::text AS to_si FROM uom'),
    () => tx.query('SELECT from_uom, to_uom, factor::text AS factor FROM item_uom_conversion WHERE item_id = $1', [itemId]),
    () => tx.query('SELECT id, name, base_qty::text AS base_qty FROM item_pack WHERE item_id = $1', [itemId]),
  ]);
  return {
    baseUom: item.rows[0].base_uom,
    uoms: new Map(uoms.rows.map((r) => [r.code, { dimension: r.dimension, toSi: r.to_si }])),
    conversions: conversions.rows.map((r) => ({ from: r.from_uom, to: r.to_uom, factor: r.factor })),
    packs: packs.rows.map((r) => ({ id: r.id, name: r.name, baseQty: r.base_qty })),
  };
}
