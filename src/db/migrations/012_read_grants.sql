-- What Claude's own SQL (sql_query, role sim_read) may read. Row-level security still applies to
-- every tenant table, so only the signed-in company's rows are ever visible.
-- Never granted: company (other companies' names), app_user, membership, api_key, oauth_*,
-- auth_event, tool_audit*, operation_journal, supplier_payout_account, schema_migrations.

GRANT SELECT ON
  brand, wiki_revision, wiki_link, wiki_log,
  item, item_uom_conversion, document_link, item_identifier, item_pack, site, location,
  lot, stock_txn, stock_balance, bom, bom_line, production_run,
  supplier, supplier_address, contact, contact_method, supplier_item,
  rfq, rfq_line, rfq_recipient, interaction,
  quote, quote_line, quote_line_break, fx_rate,
  item_spec, evaluation, purchase_order, po_line, reorder_policy,
  uom, container_type, contact_method_type
TO sim_read;

-- Column grants where a table has an internal search column.
GRANT SELECT (id, company_id, brand_id, slug, title, page_type, entity_type, entity_id, body_md, summary, tags, revision,
              status, updated_at, updated_by) ON wiki_page TO sim_read;
GRANT SELECT (id, company_id, kind, title, mime, size_bytes, sha256, storage_backend, text_content, text_source, source,
              source_ref, valid_until, scan_status, captured_by, captured_at) ON document TO sim_read;
