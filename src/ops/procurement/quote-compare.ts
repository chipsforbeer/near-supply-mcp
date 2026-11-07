import type pg from 'pg';
import { z } from 'zod';
import { defineOp } from '../define.ts';
import { requireRfq } from './common.ts';
import { landedCosts, type OfferLine } from './landed.ts';
import { currency } from '../schemas.ts';
import { dec, div, mul, str } from '../../domain/decimal.ts';

async function rateFor(tx: pg.PoolClient, from: string, to: string): Promise<{ rate: string; as_of: string; source: string } | null> {
  const direct = await tx.query(
    `SELECT rate::text AS rate, as_of, source FROM fx_rate WHERE from_currency = $1 AND to_currency = $2 ORDER BY as_of DESC, id DESC LIMIT 1`,
    [from, to],
  );
  if (direct.rows[0]) return direct.rows[0];
  const inverse = await tx.query(
    `SELECT rate::text AS rate, as_of, source FROM fx_rate WHERE from_currency = $1 AND to_currency = $2 ORDER BY as_of DESC, id DESC LIMIT 1`,
    [to, from],
  );
  if (!inverse.rows[0]) return null;
  return { ...inverse.rows[0], rate: str(div(dec('1'), dec(inverse.rows[0].rate)), 10) };
}

// Latest verdict per quote line, counting verdicts given on the line itself or on its whole quote.
async function verdictLookup(tx: pg.PoolClient, quoteLineIds: string[]): Promise<Map<string, { verdict: string; reasoning: string }>> {
  if (!quoteLineIds.length) return new Map();
  const r = await tx.query(
    `SELECT ql.id AS quote_line_id, e.verdict, e.reasoning
       FROM quote_line ql
       JOIN LATERAL (
         SELECT verdict, reasoning FROM evaluation e
          WHERE (e.subject_type = 'quote_line' AND e.subject_id = ql.id) OR (e.subject_type = 'quote' AND e.subject_id = ql.quote_id)
          ORDER BY e.decided_at DESC, e.id DESC LIMIT 1
       ) e ON true
      WHERE ql.id = ANY($1)`,
    [quoteLineIds],
  );
  return new Map(r.rows.map((row) => [row.quote_line_id, { verdict: row.verdict, reasoning: row.reasoning }]));
}

export default defineOp({
  name: 'quote_compare',
  summary:
    'Compare the quotes on an RFQ line by line: landed cost per base unit (packs needed after MOQ, volume breaks, tooling, freight share), lead time, validity and Claude\'s verdicts. Other currencies are converted only with a recorded exchange rate.',
  kind: 'read',
  scope: 'read',
  input: z.object({ rfq_id: z.uuid(), currency: currency.optional() }).strict(),
  async handler(args, tx) {
    const rfq = await requireRfq(tx, args.rfq_id);
    const rfqLines = (
      await tx.query(
        `SELECT l.id, l.line_no, l.item_id, l.qty_base::text AS qty_base, i.sku, i.name, i.base_uom
           FROM rfq_line l JOIN item i ON i.id = l.item_id WHERE l.rfq_id = $1 ORDER BY l.line_no`,
        [rfq.id],
      )
    ).rows;
    const offers = (
      await tx.query(
        `SELECT ql.id AS quote_line_id, ql.quote_id, ql.rfq_line_id, ql.item_id, ql.pack_desc, ql.pack_base_qty::text AS pack_base_qty,
                ql.price_per_pack::text AS price_per_pack, ql.moq_packs::text AS moq_packs, ql.tooling_cost::text AS tooling_cost,
                coalesce(ql.lead_time_days, q.lead_time_days) AS lead_time_days, q.supplier_id, s.name AS supplier, q.currency,
                q.freight_cost::text AS freight_cost, q.valid_until, q.incoterms, q.received_at,
                coalesce((SELECT json_agg(json_build_object('min_packs', b.min_packs::text, 'price_per_pack', b.price_per_pack::text))
                            FROM quote_line_break b WHERE b.quote_line_id = ql.id), '[]'::json) AS breaks
           FROM quote_line ql JOIN quote q ON q.id = ql.quote_id JOIN supplier s ON s.id = q.supplier_id
          WHERE q.rfq_id = $1`,
        [rfq.id],
      )
    ).rows;

    const lineFor = (o: { rfq_line_id: string | null; item_id: string }) =>
      rfqLines.find((l) => l.id === o.rfq_line_id) ?? rfqLines.find((l) => l.item_id === o.item_id);
    const matched = offers.map((o) => ({ ...o, line: lineFor(o) })).filter((o) => o.line);
    const landed = landedCosts(
      matched.map((o): OfferLine => ({
        quote_id: o.quote_id, quote_line_id: o.quote_line_id, qty_base: o.line!.qty_base, pack_base_qty: o.pack_base_qty,
        price_per_pack: o.price_per_pack, moq_packs: o.moq_packs, tooling_cost: o.tooling_cost, breaks: o.breaks, quote_freight: o.freight_cost,
      })),
    );

    const counts = new Map<string, number>();
    for (const o of matched) counts.set(o.currency, (counts.get(o.currency) ?? 0) + 1);
    const target = args.currency ?? [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const rates = new Map<string, Awaited<ReturnType<typeof rateFor>>>();
    for (const c of counts.keys()) if (target && c !== target) rates.set(c, await rateFor(tx, c, target));
    const verdicts = await verdictLookup(tx, matched.map((o) => o.quote_line_id));
    const today = new Date().toISOString().slice(0, 10);

    const result = rfqLines.map((line) => {
      const rows = matched
        .filter((o) => o.line!.id === line.id)
        .map((o) => {
          const l = landed.get(o.quote_line_id)!;
          const fx = o.currency === target ? null : rates.get(o.currency) ?? null;
          const convertible = o.currency === target || fx !== null;
          const conv = (v: string) => (o.currency === target ? v : fx ? str(mul(dec(v), dec(fx.rate))) : null);
          const verdict = verdicts.get(o.quote_line_id) ?? null;
          return {
            quote_id: o.quote_id, quote_line_id: o.quote_line_id, supplier_id: o.supplier_id, supplier: o.supplier,
            quoted_currency: o.currency, pack_desc: o.pack_desc, pack_base_qty: o.pack_base_qty, packs: l.packs, bought_base: l.bought_base,
            price_per_pack_used: l.price_per_pack_used, line_value: l.line_value, freight_share: l.freight_share,
            landed_total: convertible ? conv(l.landed_total) : null,
            landed_per_base: convertible ? conv(l.landed_per_base) : null,
            needs_exchange_rate: !convertible,
            fx_rate_used: fx,
            lead_time_days: o.lead_time_days, moq_packs: o.moq_packs, valid_until: o.valid_until,
            expired: Boolean(o.valid_until && String(o.valid_until).slice(0, 10) < today),
            incoterms: o.incoterms, verdict: verdict?.verdict ?? null, verdict_reasoning: verdict?.reasoning ?? null,
          };
        });
      const usable = rows.filter((r) => r.verdict !== 'not_good' && r.verdict !== 'needs_info');
      usable.sort((a, b) => {
        if (a.landed_per_base === null) return 1;
        if (b.landed_per_base === null) return -1;
        return dec(a.landed_per_base) < dec(b.landed_per_base) ? -1 : dec(a.landed_per_base) > dec(b.landed_per_base) ? 1 : 0;
      });
      return {
        rfq_line_id: line.id, line_no: line.line_no, sku: line.sku, name: line.name, qty_base: line.qty_base, base_uom: line.base_uom,
        offers: usable,
        incomplete: rows.filter((r) => r.verdict === 'needs_info'),
        rejected: rows.filter((r) => r.verdict === 'not_good'),
      };
    });
    return { rfq_code: rfq.rfq_code, currency: target, lines: result };
  },
});
