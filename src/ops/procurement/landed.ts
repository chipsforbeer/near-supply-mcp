import { add, ceilCount, cmp, dec, div, mul, str, type Dec } from '../../domain/decimal.ts';

export type OfferLine = {
  quote_id: string;
  quote_line_id: string;
  qty_base: string;
  pack_base_qty: string;
  price_per_pack: string;
  moq_packs: string | null;
  tooling_cost: string | null;
  breaks: { min_packs: string; price_per_pack: string }[];
  quote_freight: string | null;
};

export type Landed = {
  packs: string;
  bought_base: string;
  price_per_pack_used: string;
  line_value: string;
  freight_share: string;
  landed_total: string;
  landed_per_base: string;
};

// Whole packs needed for the quantity, never below the minimum order.
export function packsNeeded(qtyBase: string, packBase: string, moqPacks: string | null): bigint {
  const n = ceilCount(dec(qtyBase), dec(packBase));
  if (!moqPacks) return n;
  const moq = ceilCount(dec(moqPacks), dec('1'));
  return n > moq ? n : moq;
}

// The volume-break price for the largest break the order reaches.
export function priceFor(packs: bigint, base: string, breaks: { min_packs: string; price_per_pack: string }[]): string {
  let best = base;
  let bestMin: Dec = -1n;
  for (const b of breaks) {
    const min = dec(b.min_packs);
    if (cmp(dec(String(packs)), min) >= 0 && min > bestMin) {
      best = b.price_per_pack;
      bestMin = min;
    }
  }
  return best;
}

// Landed cost per base unit: what is paid (packs x price + tooling + this line's share of the quote's
// freight, shared by line value) divided by the base units actually bought.
export function landedCosts(lines: OfferLine[]): Map<string, Landed> {
  const values = new Map<string, { packs: bigint; price: string; value: Dec }>();
  const quoteTotals = new Map<string, Dec>();
  const quoteCounts = new Map<string, number>();
  for (const l of lines) {
    const packs = packsNeeded(l.qty_base, l.pack_base_qty, l.moq_packs);
    const price = priceFor(packs, l.price_per_pack, l.breaks);
    const value = add(mul(dec(String(packs)), dec(price)), dec(l.tooling_cost ?? '0'));
    values.set(l.quote_line_id, { packs, price, value });
    quoteTotals.set(l.quote_id, add(quoteTotals.get(l.quote_id) ?? 0n, value));
    quoteCounts.set(l.quote_id, (quoteCounts.get(l.quote_id) ?? 0) + 1);
  }
  const out = new Map<string, Landed>();
  for (const l of lines) {
    const v = values.get(l.quote_line_id)!;
    const freight = dec(l.quote_freight ?? '0');
    const total = quoteTotals.get(l.quote_id) ?? 0n;
    const share = freight === 0n ? 0n : total === 0n ? div(freight, dec(String(quoteCounts.get(l.quote_id) ?? 1))) : div(mul(freight, v.value), total);
    const bought = mul(dec(String(v.packs)), dec(l.pack_base_qty));
    const landedTotal = add(v.value, share);
    out.set(l.quote_line_id, {
      packs: String(v.packs),
      bought_base: str(bought),
      price_per_pack_used: str(dec(v.price)),
      line_value: str(v.value),
      freight_share: str(share),
      landed_total: str(landedTotal),
      landed_per_base: str(div(landedTotal, bought)),
    });
  }
  return out;
}
