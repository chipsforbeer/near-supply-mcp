# SQL: read-only questions the operations do not answer

For ad hoc reports (totals, trends, joins across modules), read-only and limited to this company.

## Using it

`sql_query` with one `SELECT` (joins, `WITH` subqueries, unions, aggregates, window functions)
and `max_rows` (default 100, at most 1000). The result has `columns`, `rows` (arrays),
`row_count` and `truncated`.

```js
async () => (await api.call('sql_query', {
  sql: `SELECT i.sku, sum(b.qty_base) AS on_hand FROM item i JOIN stock_balance b ON b.item_id = i.id
        GROUP BY i.sku ORDER BY on_hand`,
  max_rows: 50,
})).rows
```

## What is allowed

- Business tables only: items, packs, identifiers, conversions, sites and locations, lots,
  stock transactions and balances, BOMs and production runs, suppliers, addresses, contacts,
  methods, supplier items, RFQs, interactions, quotes and lines, FX rates, specs, evaluations,
  purchase orders and lines, reorder policies, documents and links, wiki pages, revisions and
  links.
- Common functions (count, sum, avg, min, max, round, date_trunc, to_char, string_agg,
  row_number, lag, coalesce and similar).

Refused: anything that writes, more than one statement, comments, settings functions, system
catalogs, recursive queries, unknown functions, and the identity, audit and payout tables. Row
level security limits every table to this company whatever the query says.

Prefer the operations when one fits: they apply units, packs and rules that raw SQL does not.
Never change data this way; there is no way to.
