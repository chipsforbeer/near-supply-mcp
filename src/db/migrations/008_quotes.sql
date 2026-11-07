-- Quotes as received, volume price breaks, and exchange rates Claude records with a source and date.

CREATE TABLE quote (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  rfq_id uuid NULL,
  supplier_id uuid NOT NULL,
  quote_ref text NULL,
  received_at timestamptz NOT NULL,
  valid_until date NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  incoterms text NULL,
  payment_terms text NULL,
  lead_time_days int NULL CHECK (lead_time_days >= 0),
  freight_cost numeric(20,6) NULL CHECK (freight_cost >= 0),
  source_document_id uuid NULL,
  interaction_id uuid NULL,
  notes text NULL,
  recorded_by uuid NOT NULL REFERENCES app_user,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, rfq_id) REFERENCES rfq (company_id, id),
  FOREIGN KEY (company_id, supplier_id) REFERENCES supplier (company_id, id),
  FOREIGN KEY (company_id, source_document_id) REFERENCES document (company_id, id),
  FOREIGN KEY (company_id, interaction_id) REFERENCES interaction (company_id, id)
);

CREATE TABLE quote_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  quote_id uuid NOT NULL,
  rfq_line_id uuid NULL,
  item_id uuid NOT NULL,
  pack_desc text NULL,
  pack_base_qty numeric(20,6) NOT NULL CHECK (pack_base_qty > 0),
  price_per_pack numeric(20,6) NOT NULL CHECK (price_per_pack >= 0),
  moq_packs numeric(20,6) NULL CHECK (moq_packs > 0),
  tooling_cost numeric(20,6) NULL CHECK (tooling_cost >= 0),
  lead_time_days int NULL CHECK (lead_time_days >= 0),
  price_per_base numeric GENERATED ALWAYS AS (price_per_pack / pack_base_qty) STORED,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, quote_id) REFERENCES quote (company_id, id),
  FOREIGN KEY (company_id, rfq_line_id) REFERENCES rfq_line (company_id, id),
  FOREIGN KEY (company_id, item_id) REFERENCES item (company_id, id)
);

CREATE TABLE quote_line_break (
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  quote_line_id uuid NOT NULL,
  min_packs numeric(20,6) NOT NULL CHECK (min_packs > 0),
  price_per_pack numeric(20,6) NOT NULL CHECK (price_per_pack >= 0),
  PRIMARY KEY (company_id, quote_line_id, min_packs),
  FOREIGN KEY (company_id, quote_line_id) REFERENCES quote_line (company_id, id)
);

CREATE TABLE fx_rate (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  from_currency char(3) NOT NULL CHECK (from_currency ~ '^[A-Z]{3}$'),
  to_currency char(3) NOT NULL CHECK (to_currency ~ '^[A-Z]{3}$'),
  rate numeric(24,10) NOT NULL CHECK (rate > 0),
  as_of date NOT NULL,
  source text NOT NULL CHECK (length(source) BETWEEN 3 AND 300),
  recorded_by uuid NOT NULL REFERENCES app_user,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_currency <> to_currency)
);
CREATE INDEX fx_rate_pair ON fx_rate (company_id, from_currency, to_currency, as_of DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quote','quote_line','quote_line_break','fx_rate'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id())
                    WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON quote, quote_line, quote_line_break, fx_rate TO sim_app;
