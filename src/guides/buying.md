# Buying: RFQs, quotes, purchase orders, payment and receiving

From a need to goods on the shelf: ask for quotes, judge them, order, pay through the payment tool, receive.

## 1. Ask for quotes

1. `rfq_create` with `site_code`, `trigger` (`low_stock`, `manual`, `project`) and `lines`
   (`item_id`, `qty` with `uom` or `pack`, optional `preferred_pack`); `needed_by` if dated.
2. Pick suppliers (`supplier_search` by `item_id` or `capability`; find new ones on the web
   and add them, see the suppliers guide), then `rfq_add_recipients`.
3. Send the requests by email and log each one (outreach guide).

`rfq_get` reads an RFQ with lines and recipients; `rfq_list` lists them; `rfq_status_set`
cancels one, marks it awarded, or records a recipient's status.

## 2. Record quotes

When a reply arrives, keep the attachment with `document_add` (documents guide), log the email, then
`quote_record`: `supplier_id`, `rfq_id`, `quote_ref`, `received_at`, `currency`,
`lead_time_days`, `freight_cost`, `valid_until`, `source_document_id`, `interaction_id`, and
`lines` (`rfq_line_id`, `item_id`, the pack they quote: `pack_qty` with `pack_uom` or a known
`pack`, `price_per_pack`, `moq_packs`, `breaks` for volume prices). Record exactly what the
document says, including anything that differs from what was asked.

Different currencies: `fx_rate_record` (`from_currency`, `to_currency`, `rate`, `as_of`,
`source`) before comparing. A missing rate is an error, never assumed.

## 3. Judge and compare

1. Check each quote line against the item's active spec (specs guide) and record
   `evaluation_log` for it (`subject_type: quote_line`, `verdict`, `reasoning`, evidence).
2. `quote_compare` for the RFQ: for each line, usable offers ranked by landed cost per base
   unit (price plus freight, converted to one currency) and the offers judged `not_good`.
3. Tell the user your recommendation and why.

## 4. Order (approve to approve)

1. `po_create` with `supplier_id`, `site_code`, `currency`, `quote_id`, `freight_cost` and
   `lines` (`item_id`, `qty`, `price_per_base`, `quote_line_id`).
2. `po_approve` needs the approve permission: it fixes `approved_max_amount`. Only approve
   when an approver has said so.
3. Send the order to the supplier by email; `po_status_set` `sent`, then `acknowledged`.

## 5. Pay (through the payment tool)

1. The supplier needs a confirmed payout account (suppliers guide).
2. `po_payment_instruction` returns what the payment tool needs (network, account, token,
   amount, approval). It refuses unapproved orders, missing payout accounts and amounts above
   the approval, and marks the order instructed.
3. Pay with the payment tool. This server never moves money.
4. `po_payment_record` with the `network`, `payment_ref` (transaction id) and `outcome`
   (`paid` or `failed`).

## 6. Receive

`po_receive` with the `po_id`, `location_code`, and per line `po_line_id`, `qty` (with `uom`
or `pack`), `lot_code`, `supplier_lot_code`, `expires_on` and `cert_document_id` (the
certificate, kept with `document_add`). Receive into a location of kind `quarantine` (a QC area) when the goods
must be checked: those lots wait in quarantine and do not count as available until you check
them (specs guide) and release them with `lot_status_set`; then `stock_move` a `transfer` to
storage. Lots received anywhere else are released at once. `po_get` shows the order, its
lines, approval, payment and receipts.
