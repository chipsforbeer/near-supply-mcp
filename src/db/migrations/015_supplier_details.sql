-- More about each supplier:
-- - tax and company registration numbers;
-- - offerings: what a supplier can supply in general (products and services), beyond the items
--   we already buy from them (supplier_item).
-- - a retired mark on contact methods: an old email or phone is kept (past interactions point at
--   it) but hidden and no longer used for new contact.
-- Certifications and similar detail belong on the supplier's wiki page.

ALTER TABLE supplier
  ADD COLUMN tax_id text NULL CHECK (length(tax_id) BETWEEN 1 AND 60),
  ADD COLUMN registration_number text NULL CHECK (length(registration_number) BETWEEN 1 AND 60);

ALTER TABLE contact_method ADD COLUMN removed_at timestamptz NULL;

CREATE TABLE supplier_offering (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  supplier_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('product', 'service')),
  category text NOT NULL CHECK (length(category) BETWEEN 1 AND 120),
  description text NULL CHECK (length(description) <= 2000),
  tags text[] NOT NULL DEFAULT '{}',
  min_order text NULL CHECK (length(min_order) <= 200),
  lead_time_days_min int NULL CHECK (lead_time_days_min BETWEEN 0 AND 730),
  lead_time_days_max int NULL CHECK (lead_time_days_max BETWEEN 0 AND 730),
  price_note text NULL CHECK (length(price_note) <= 500),
  source text NULL CHECK (length(source) <= 500),
  document_id uuid NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'discontinued')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (lead_time_days_min IS NULL OR lead_time_days_max IS NULL OR lead_time_days_min <= lead_time_days_max),
  FOREIGN KEY (company_id, supplier_id) REFERENCES supplier (company_id, id),
  FOREIGN KEY (company_id, document_id) REFERENCES document (company_id, id)
);
CREATE INDEX supplier_offering_supplier ON supplier_offering (company_id, supplier_id);

ALTER TABLE supplier_offering ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_offering FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON supplier_offering USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());

-- Nothing is deleted: an offering that ends is marked discontinued.
GRANT SELECT, INSERT, UPDATE ON supplier_offering TO sim_app;
GRANT SELECT ON supplier_offering TO sim_read;
