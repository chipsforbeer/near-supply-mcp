-- Suppliers (existing and discovered), contacts, how to reach them, what they sell us,
-- and payout accounts for the payment MCP.

CREATE TABLE supplier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  name_norm text NOT NULL,
  legal_name text NULL,
  website text NULL,
  email_domain text NULL,
  country_code char(2) NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  supplier_type text NULL CHECK (supplier_type IN ('manufacturer','distributor','trader','job_shop','service')),
  capabilities text[] NOT NULL DEFAULT '{}',
  default_currency char(3) NULL CHECK (default_currency ~ '^[A-Z]{3}$'),
  payment_terms text NULL,
  default_incoterms text NULL,
  origin text NOT NULL CHECK (origin IN ('existing','discovered')),
  discovered_for_rfq uuid NULL,
  discovery_sources text[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('prospect','approved','preferred','on_hold','blocked')),
  tags text[] NOT NULL DEFAULT '{}',
  rating smallint NULL CHECK (rating BETWEEN 1 AND 5),
  notes text NULL,
  last_contacted_at timestamptz NULL,
  last_reply_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);
CREATE INDEX supplier_name_norm ON supplier (company_id, name_norm);
CREATE INDEX supplier_domain ON supplier (company_id, email_domain);

ALTER TABLE lot ADD FOREIGN KEY (company_id, supplier_id) REFERENCES supplier (company_id, id);

CREATE TABLE supplier_address (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  supplier_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('hq','factory','warehouse','billing','pickup')),
  lines text NOT NULL,
  city text NULL,
  region text NULL,
  postal_code text NULL,
  country_code char(2) NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  FOREIGN KEY (company_id, supplier_id) REFERENCES supplier (company_id, id)
);

CREATE TABLE contact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  supplier_id uuid NOT NULL,
  full_name text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 160),
  job_title text NULL,
  department text NULL,
  is_primary boolean NOT NULL DEFAULT false,
  handles text[] NOT NULL DEFAULT '{}'
    CHECK (handles <@ ARRAY['quotes','orders','quality','accounts','technical','logistics']),
  language text NULL,
  timezone text NULL,
  may_contact_on_behalf boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','left')),
  notes text NULL,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, supplier_id) REFERENCES supplier (company_id, id)
);

-- Global lookup: a new channel is a row, not a migration.
CREATE TABLE contact_method_type (
  code text PRIMARY KEY,
  label text NOT NULL,
  is_messaging boolean NOT NULL
);
INSERT INTO contact_method_type (code, label, is_messaging) VALUES
  ('email', 'Email', true), ('phone', 'Phone', false), ('mobile', 'Mobile', false), ('sms', 'SMS', true),
  ('whatsapp', 'WhatsApp', true), ('line', 'LINE', true), ('wechat', 'WeChat', true), ('telegram', 'Telegram', true),
  ('signal', 'Signal', true), ('fax', 'Fax', false), ('website_form', 'Website form', false),
  ('portal', 'Supplier portal', false), ('linkedin', 'LinkedIn', true);

CREATE TABLE contact_method (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  supplier_id uuid NOT NULL,
  contact_id uuid NULL,
  type_code text NOT NULL REFERENCES contact_method_type,
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 300),
  value_norm text NOT NULL,
  label text NULL,
  is_preferred boolean NOT NULL DEFAULT false,
  do_not_contact boolean NOT NULL DEFAULT false,
  verified_at timestamptz NULL,
  notes text NULL,
  UNIQUE (company_id, supplier_id, type_code, value_norm),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, supplier_id) REFERENCES supplier (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contact (company_id, id)
);
CREATE INDEX contact_method_norm ON contact_method (company_id, type_code, value_norm);

CREATE TABLE supplier_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  supplier_id uuid NOT NULL,
  item_id uuid NOT NULL,
  supplier_sku text NULL,
  supplier_item_name text NULL,
  purchase_pack_id uuid NULL,
  moq_base numeric(20,6) NULL CHECK (moq_base > 0),
  lead_time_days int NULL CHECK (lead_time_days >= 0),
  last_price numeric(20,6) NULL CHECK (last_price >= 0),
  last_price_per text NULL CHECK (last_price_per IN ('base','pack')),
  last_price_currency char(3) NULL CHECK (last_price_currency ~ '^[A-Z]{3}$'),
  last_priced_at date NULL,
  is_preferred boolean NOT NULL DEFAULT false,
  UNIQUE (company_id, supplier_id, item_id),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, supplier_id) REFERENCES supplier (company_id, id),
  FOREIGN KEY (company_id, item_id) REFERENCES item (company_id, id),
  FOREIGN KEY (company_id, purchase_pack_id) REFERENCES item_pack (company_id, id)
);
CREATE UNIQUE INDEX supplier_item_one_preferred ON supplier_item (company_id, item_id) WHERE is_preferred;

CREATE TABLE supplier_payout_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  supplier_id uuid NOT NULL,
  network text NOT NULL CHECK (network IN ('near')),
  account_id text NOT NULL CHECK (length(account_id) BETWEEN 2 AND 64),
  token text NOT NULL CHECK (length(token) BETWEEN 1 AND 100),
  note text NOT NULL,
  set_by uuid NOT NULL REFERENCES app_user,
  set_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz NULL,
  FOREIGN KEY (company_id, supplier_id) REFERENCES supplier (company_id, id)
);
CREATE UNIQUE INDEX payout_current ON supplier_payout_account (company_id, supplier_id, network) WHERE superseded_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier','supplier_address','contact','contact_method','supplier_item','supplier_payout_account'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id())
                    WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT ON contact_method_type TO sim_app;
GRANT SELECT, INSERT, UPDATE ON supplier, contact, contact_method, supplier_item TO sim_app;
GRANT SELECT, INSERT, DELETE ON supplier_address TO sim_app;
GRANT SELECT, INSERT ON supplier_payout_account TO sim_app;
GRANT UPDATE (superseded_at) ON supplier_payout_account TO sim_app;
