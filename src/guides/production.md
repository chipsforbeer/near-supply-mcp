# Production: bills of materials and production runs

Recipes for what the factory makes, and recording runs so their materials leave stock.

## Bills of materials

`bom_upsert` for an output item: `batch_qty` (with `batch_uom` or `batch_pack`), optional
`expected_yield`, and `lines` (each `item_id` and `qty` with `uom` or `pack`, optional
`scrap_factor`, and `scales_with_batch: false` for fixed amounts such as a cleaning dose).
Saving a changed recipe makes a new version; `bom_get` reads the current one or a `version`.

## Recording a run

`production_run_record` with `output_item_id`, `run_code` (the work order), `site_code`,
`consume_location_code` (where materials are taken from), `output_location_code` (where the
product goes) and `actual_output_qty`.

- Materials are consumed from the BOM, scaled to the run. Pass `actual_lines` when actual use
  differed from the recipe.
- Lot-tracked materials are taken first-expiry-first-out unless you name lots in
  `component_lots`.
- A lot-tracked product gets a lot: `output_lot_code`, or the `run_code` when you leave it out.
  For an output item that is not lot-tracked, leave `output_lot_code` out.
- `started_at` and `finished_at` date the run; consumption shows in usage, so days-of-cover
  reorder points follow real production.

If a run fails because a material is short at that location, check `stock_levels`: the stock
may be in another location (transfer it first) or held in quarantine (see the specs guide).
