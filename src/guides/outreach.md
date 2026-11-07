# Outreach: emailing suppliers and logging every contact

This server does not send email. Use the user's own mail tool, and record every email and call here.

## Sending

1. Check the company rules first (some require the user's OK before the first email to a new
   supplier).
2. Write from the user's mailbox with their mail tool (Gmail, Outlook). Say who you are writing
   for, and sign as the rules say.
3. Never share one supplier's prices or terms with another.

## Logging

Every email or call, sent or received, gets one `interaction_log`: `supplier_id`
(`contact_id` and `contact_method_id` when known), `direction` (`out` or `in`), `channel`,
`purpose` (`rfq`, `follow_up`, `spec_request`, `negotiation`, `order`, `complaint`...),
`subject`, a short factual `summary`, `occurred_at`, and `rfq_id` when it is about an RFQ.
Put the mail thread id in `external_thread_id` so later replies can be matched, and attach
saved attachments with `document_ids` (keep them first, see the documents guide).

## Following up

`outreach_status` for an RFQ shows each recipient's state and how long they have been silent.
Follow up on the silent ones (log each follow-up as `purpose: follow_up`). When a supplier
declines, stops answering or is ruled out, record it with `rfq_status_set` (`supplier_id` and
`recipient_status`: `declined`, `no_response`, `disqualified`, with a `note`).

Update the supplier's wiki page with what was said (timeline, offers, open questions).
