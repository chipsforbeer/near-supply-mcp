-- Lots, the append-only stock ledger, and balances maintained in the same transaction.
-- lot.supplier_id gets its foreign key when the supplier table exists (006).

CREATE TABLE lot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  item_id uuid NOT NULL,
  lot_code text NOT NULL CHECK (length(lot_code) BETWEEN 1 AND 80),
  supplier_id uuid NULL,
  supplier_lot_code text NULL,
  received_on date NULL,
  manufactured_on date NULL,
  expires_on date NULL,
  status text NOT NULL DEFAULT 'released' CHECK (status IN ('quarantine','released','on_hold','rejected')),
  status_note text NULL,
  cert_document_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, item_id, lot_code),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, item_id) REFERENCES item (company_id, id),
  FOREIGN KEY (company_id, cert_document_id) REFERENCES document (company_id, id)
);

CREATE TABLE stock_txn (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  item_id uuid NOT NULL,
  location_id uuid NOT NULL,
  lot_id uuid NULL,
  txn_type text NOT NULL CHECK (txn_type IN ('opening_balance','receipt','production_output','transfer_in',
    'issue','production_consume','transfer_out','scrap','return_to_supplier','sample','count_correction','reversal')),
  qty_base numeric(20,6) NOT NULL,
  entered_qty numeric(20,6) NULL,
  entered_pack_id uuid NULL,
  entered_uom text NULL REFERENCES uom,
  counted_qty_base numeric(20,6) NULL,
  reference_type text NULL CHECK (reference_type IN ('po','production_run','transfer','count','reversal')),
  reference_id uuid NULL,
  reverses_txn_id bigint NULL,
  note text NULL CHECK (length(note) <= 1000),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid NOT NULL REFERENCES app_user,
  via_agent boolean NOT NULL,
  UNIQUE (company_id, id),
  CHECK (CASE
    WHEN txn_type IN ('opening_balance','receipt','production_output','transfer_in') THEN qty_base > 0
    WHEN txn_type IN ('issue','production_consume','transfer_out','scrap','return_to_supplier','sample') THEN qty_base < 0
    ELSE qty_base <> 0 END),
  CHECK ((txn_type = 'reversal') = (reverses_txn_id IS NOT NULL)),
  FOREIGN KEY (company_id, item_id) REFERENCES item (company_id, id),
  FOREIGN KEY (company_id, location_id) REFERENCES location (company_id, id),
  FOREIGN KEY (company_id, lot_id) REFERENCES lot (company_id, id),
  FOREIGN KEY (company_id, entered_pack_id) REFERENCES item_pack (company_id, id),
  FOREIGN KEY (company_id, reverses_txn_id) REFERENCES stock_txn (company_id, id)
);
CREATE UNIQUE INDEX stock_txn_reversed_once ON stock_txn (company_id, reverses_txn_id) WHERE reverses_txn_id IS NOT NULL;
CREATE INDEX stock_txn_item_time ON stock_txn (company_id, item_id, occurred_at);
CREATE INDEX stock_txn_reference ON stock_txn (company_id, reference_type, reference_id);

CREATE TABLE stock_balance (
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  item_id uuid NOT NULL,
  location_id uuid NOT NULL,
  lot_id uuid NULL,
  qty_base numeric(20,6) NOT NULL CHECK (qty_base >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (company_id, item_id, location_id, lot_id),
  FOREIGN KEY (company_id, item_id) REFERENCES item (company_id, id),
  FOREIGN KEY (company_id, location_id) REFERENCES location (company_id, id),
  FOREIGN KEY (company_id, lot_id) REFERENCES lot (company_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lot','stock_txn','stock_balance'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id())
                    WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON lot TO sim_app;
GRANT UPDATE (status, status_note, cert_document_id, expires_on, supplier_id, supplier_lot_code) ON lot TO sim_app;
GRANT SELECT, INSERT ON stock_txn TO sim_app;
GRANT SELECT, INSERT, UPDATE ON stock_balance TO sim_app;
