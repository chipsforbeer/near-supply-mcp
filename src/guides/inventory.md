# Inventory: items, packs, locations, stock and reorder

Set up items with their units and packs, record every stock movement, and find what is running low.

## Setting up an item

1. `item_search` first (by words, `identifier` such as an MPN or CAS number, or `category`)
   so you do not create a duplicate. `item_get` reads one by `item_id` or `sku`.
2. `item_upsert` with `sku`, `name`, `category`, `physical_form`, `sourcing_type` and
   `base_uom` (the unit stock is kept in: `each`, `kg`, `L`, `m`...). Set `is_lot_tracked`
   for anything with heats, batches or expiry, and `shelf_life_days` when it expires.
3. `item_pack_upsert` for each way it is bought or stored: `name` ("sack 25 kg"),
   `contains_qty` and either base units or `contains_pack` to nest packs ("pallet of 40
   sacks" contains 40 of "sack 25 kg"). `container_kind` says what it physically is.
4. `item_conversion_set` when the item is counted in two kinds of unit (litres and kilograms
   of a liquid): `from_uom`, `to_uom`, `factor`.
5. `item_identifier_add` for MPNs, CAS numbers, drawing numbers, standards, HS codes.

`container_type_list` lists the container kinds. `location_upsert` creates locations
(`kind`: rack, bin, tank, quarantine, receiving, line...) at a site; it creates the site too
when you give `site_name` and `timezone`. Use a location of kind `quarantine` for goods
waiting to be checked.

## Recording stock

Stock is an append-only ledger. Every change is one `stock_move`:

```text
receipt / opening_balance   into location_code (lot_code for lot-tracked items)
issue / scrap / sample      out of location_code
return_to_supplier          out, back to the supplier
transfer                    location_code -> to_location_code
```

- Lot-tracked items need `lot_code` on receipts; `expires_on` when it applies.
- `stock_count` records a physical count; the server books the difference.
- Mistakes are fixed with `stock_reverse` (`txn_id` from `stock_history`), never by
  editing.
- `stock_levels` gives on-hand by item and location; `stock_history` the movements.
- `lot_status_set` puts a lot `on_hold`, `rejected`, `quarantine` or `released`. Only
  released (or untracked) stock counts as available.

Goods received from a purchase order arrive through `po_receive` (buying guide), not
`stock_move`.

## Low stock

1. `reorder_policy_set` per item and site: `days_of_cover` (uses recent usage,
   `safety_days`, `target_cover_days`, the lead time), `min_max` (`min_qty`, `max_qty`) or
   `manual`.
2. `low_stock_report` lists items with `status` `ok`, `reorder`, `critical`,
   `needs_lead_time` or `needs_usage_history`, with a suggestion in packs
   (`suggest_display`, for example "2 x bundle of 20 sheets"). `include_ok` shows all.
3. For anything at `reorder` or `critical`, start an RFQ (buying guide).

A `needs_lead_time` status means no supplier lead time is known: record it with
`supplier_item_upsert` or set `lead_time_override`.
