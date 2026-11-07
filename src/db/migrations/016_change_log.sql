-- Every change to a company's records is kept with its before and after values, tied to the
-- operation that made it (operation_journal: who, which operation, and the reason).
-- A trigger writes the log with the owner's rights; the app can only read it, so log entries
-- cannot be added, changed or removed by anything the app does.
-- Inserts keep the new row, deletes the old row, updates only the fields that changed.
-- Tables that keep their own full history are not logged here: wiki pages (wiki_revision),
-- stock balances (derived from the stock_txn ledger), payout accounts (every version kept),
-- and the audit and sign-in tables themselves. Tables the app can only insert into are their
-- own record. A test fails if a changeable company table is neither logged nor listed.

CREATE TABLE change_log (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES company,
  at timestamptz NOT NULL DEFAULT now(),
  table_name text NOT NULL,
  row_id text NULL,
  action text NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  before jsonb NULL,
  after jsonb NULL,
  journal_id bigint NULL
);
CREATE INDEX change_log_row ON change_log (company_id, table_name, row_id, id DESC);
CREATE INDEX change_log_recent ON change_log (company_id, id DESC);
CREATE INDEX change_log_journal ON change_log (journal_id);

-- Readers see only their company. Not forced: the owner-rights trigger writes for every company.
ALTER TABLE change_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON change_log USING (company_id = app_company_id());
GRANT SELECT ON change_log TO sim_app, sim_read;

CREATE FUNCTION log_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  -- Never logged: the company itself, search indexes, bulky extracted text, derived keys and
  -- the edit's own timestamp.
  skip text[] := ARRAY['company_id', 'search', 'text_content', 'name_norm', 'value_norm', 'updated_at'];
  o jsonb;
  n jsonb;
  b jsonb;
  a jsonb;
  company uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN company := OLD.company_id; ELSE company := NEW.company_id; END IF;
  -- Shared reference rows (no company) are changed only by migrations.
  IF company IS NULL THEN RETURN NULL; END IF;
  IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD) - skip; END IF;
  IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW) - skip; END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(k, o -> k), jsonb_object_agg(k, n -> k) INTO b, a
      FROM jsonb_object_keys(n) AS k
     WHERE (o -> k) IS DISTINCT FROM (n -> k);
    IF b IS NULL THEN RETURN NULL; END IF;
  ELSE
    b := o;
    a := n;
  END IF;
  INSERT INTO change_log (company_id, table_name, row_id, action, before, after, journal_id)
  VALUES (company, TG_TABLE_NAME, coalesce(n ->> 'id', o ->> 'id'), lower(TG_OP), b, a,
          nullif(current_setting('app.journal_id', true), '')::bigint);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION log_change() FROM PUBLIC;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bom', 'brand', 'contact', 'contact_method', 'container_type', 'document', 'item', 'item_identifier', 'item_pack',
    'item_spec', 'item_uom_conversion', 'location', 'lot', 'po_line', 'production_run', 'purchase_order', 'reorder_policy',
    'rfq', 'rfq_line', 'rfq_recipient', 'site', 'supplier', 'supplier_address', 'supplier_item', 'supplier_offering'
  ] LOOP
    EXECUTE format('CREATE TRIGGER log_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION log_change()', t);
  END LOOP;
END $$;
