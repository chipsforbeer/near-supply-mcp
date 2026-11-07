# Specs and evaluations: what good looks like, and your verdicts

Each item can have a spec; you judge quotes and deliveries against it and record every verdict with reasoning.

## Specs

`spec_upsert` for an item: `body_md` (the requirements in Markdown: grade, dimensions and
tolerances, certificates, packaging, test methods), `status` (`active` or `draft`),
`effective_from`, and `document_ids` (the spec sheet or drawing, kept first with `document_add`). Each change
makes a new version; `spec_get` reads the active one or a `version`. Never write a spec value
nobody gave you; ask, or record what the document says.

## Verdicts

`evaluation_log` records one judgement:

```text
subject_type   quote_line, quote, lot, supplier_item, supplier
subject_id     the record judged
verdict        good, not_good, needs_info
reasoning      what you compared and why it passes or fails, in plain words
spec_version   the spec version you judged against
evidence_document_ids   the quote, certificate or test report you relied on
supersedes_id  the earlier verdict this one replaces, when you correct yourself
```

There is no rule engine: the verdict is yours, so the reasoning must let a person check it.
Quote lines judged `not_good` drop out of `quote_compare`. `evaluation_list` shows verdicts
by subject or verdict.

## Releasing a delivery

Lots received into a quarantine location wait there until released.

1. Read the certificate or test report that came with the lot (keep it with
   `document_add`, or `document_get` for the text already saved).
2. Compare it with the active spec; `evaluation_log` on the `lot` with the evidence.
3. If good, `lot_status_set` `released` with a note citing the spec version; if not,
   `rejected` or `on_hold`, and tell the user. Only released lots count as available stock.
