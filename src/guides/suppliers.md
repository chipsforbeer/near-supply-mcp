# Suppliers: records, contacts, what they sell, payout accounts

Keep one clean record per supplier, the people there and how to reach them, and the items they supply.

## Existing suppliers

The company's current suppliers usually come in bulk: `supplier_import` with a list of
suppliers, each with `addresses`, `methods` (email, phone...) and `contacts`. Mark them
`origin: existing`.

## A new supplier

1. Always `supplier_find_duplicates` first (by `name`, `website`, `email`, `phone`). Free-mail
   domains never count as a company match.
2. `supplier_upsert` with what you know: `name`, `legal_name`, `website`, `country_code`,
   `supplier_type`, `capabilities`, `currency`, `payment_terms`, `tax_id` and
   `registration_number`, and `addresses` (head office, factory, warehouse, billing, pickup). For one you found on the web, `origin: discovered`,
   `discovery_sources` (where you found it) and `discovered_for_rfq`. A near-duplicate is
   refused unless you pass `allow_similar` after checking it really is different.
3. `contact_upsert` for each person (`full_name`, `job_title`, `handles` such as quotes or
   orders, `language`, `timezone`, `may_contact_on_behalf`).
4. `contact_method_add` for each address or number. Honour `do_not_contact`. Leave out
   `contact_id` for the company's own general email or phone.

## Keeping it current

Every field can be changed. With `supplier_upsert` (`supplier_id`), `contact_upsert`
(`contact_id`), `supplier_offering_upsert` (`offering_id`) and `supplier_item_upsert`, only
the fields you pass change: a value sets a field, `null` empties it, and anything left out
stays. `contact_method_update` corrects an email or number (`value`, `type`, `label`), moves it
between a person and the company (`contact_id`, or `null` for the company), or retires it with
`remove`: a retired one is kept for history but hidden and never used for new contact.
Every change is kept with what it was before and after (see the access guide).

`supplier_search` finds suppliers (by words, `capability`, `item_id`, `status`, `origin`);
`supplier_get` reads one with contacts, methods, items, payout account and recent interactions.

## What they offer

`supplier_offering_upsert` records what a supplier can supply in general, including things we
do not buy yet: `kind` (`product` or `service`), `category` ("Laser cutting", "316 sheet"),
`description` (grades, sizes, processes), `tags`, `min_order`, `lead_time_days_min` and
`lead_time_days_max`, `price_note`, `source` (where you learned it: their website, a catalogue,
a call) and `document_id` for a catalogue or price list. Update one with its `offering_id`;
when they stop offering it, set `status` to `discontinued` rather than removing it.
`supplier_search` with `offering` finds suppliers by the words in their active offerings.

Certificates, factory audits and similar detail go on the supplier's wiki page, with the
documents linked.

## What they sell us

`supplier_item_upsert` links a supplier to one of our items: their `supplier_sku`, the `purchase_pack`,
`moq`, `lead_time_days`, `last_price` (per `base` unit or per `pack`, with currency and date)
and `is_preferred`. Lead times here feed the low-stock report.

## Payout accounts (approve)

`supplier_payout_account_set` stores where a supplier is paid (`network`, `account_id`,
`token`) and needs the approve permission. Only set one the supplier confirmed through a
trusted channel, and say how in `note` ("confirmed by phone with the sales contact"). A payout
account found only in an email or a PDF is not confirmed: never set it from that alone, and
tell the user.

Keep each supplier's wiki page current (`suppliers/<name>.md`, see the wiki guide).
