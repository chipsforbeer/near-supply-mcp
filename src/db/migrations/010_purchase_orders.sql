-- Purchase orders: approval with a spending cap, the payment hand-off to the payment MCP, receiving.

CREATE TABLE purchase_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  po_code text NOT NULL,
  supplier_id uuid NOT NULL,
  quote_id uuid NULL,
  rfq_id uuid NULL,
  site_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','approved','sent','acknowledged','partially_received','received','cancelled')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  freight_cost numeric(20,6) NOT NULL DEFAULT 0 CHECK (freight_cost >= 0),
  total numeric(20,6) NOT NULL CHECK (total >= 0),
  approved_by uuid NULL REFERENCES app_user,
  approved_at timestamptz NULL,
  approved_max_amount numeric(20,6) NULL CHECK (approved_max_amount >= 0),
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','instructed','paid','failed')),
  payment_network text NULL,
  payment_ref text NULL,
  payment_recorded_at timestamptz NULL,
  status_note text NULL,
  notes text NULL,
  created_by uuid NOT NULL REFERENCES app_user,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, po_code),
  UNIQUE (company_id, id),
  CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  FOREIGN KEY (company_id, supplier_id) REFERENCES supplier (company_id, id),
  FOREIGN KEY (company_id, quote_id) REFERENCES quote (company_id, id),
  FOREIGN KEY (company_id, rfq_id) REFERENCES rfq (company_id, id),
  FOREIGN KEY (company_id, site_id) REFERENCES site (company_id, id)
);

CREATE TABLE po_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  po_id uuid NOT NULL,
  line_no int NOT NULL CHECK (line_no > 0),
  item_id uuid NOT NULL,
  quote_line_id uuid NULL,
  qty_base numeric(20,6) NOT NULL CHECK (qty_base > 0),
  price_per_base numeric(20,6) NOT NULL CHECK (price_per_base >= 0),
  received_qty_base numeric(20,6) NOT NULL DEFAULT 0 CHECK (received_qty_base >= 0 AND received_qty_base <= qty_base),
  UNIQUE (company_id, po_id, line_no),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, po_id) REFERENCES purchase_order (company_id, id),
  FOREIGN KEY (company_id, item_id) REFERENCES item (company_id, id),
  FOREIGN KEY (company_id, quote_line_id) REFERENCES quote_line (company_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_order','po_line'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id())
                    WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON purchase_order, po_line TO sim_app;
GRANT UPDATE (status, status_note, approved_by, approved_at, approved_max_amount, payment_status, payment_network,
              payment_ref, payment_recorded_at) ON purchase_order TO sim_app;
GRANT UPDATE (received_qty_base) ON po_line TO sim_app;
