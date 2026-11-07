-- Requests for quotation, who was asked, and the log of every contact with a supplier.

CREATE TABLE rfq (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  rfq_code text NOT NULL,
  site_id uuid NOT NULL,
  brand_id uuid NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','quoting','awarded','cancelled')),
  trigger text NOT NULL CHECK (trigger IN ('low_stock','manual','project')),
  needed_by date NULL,
  notes text NULL,
  status_note text NULL,
  created_by uuid NOT NULL REFERENCES app_user,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, rfq_code),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, site_id) REFERENCES site (company_id, id),
  FOREIGN KEY (company_id, brand_id) REFERENCES brand (company_id, id)
);

ALTER TABLE supplier ADD FOREIGN KEY (company_id, discovered_for_rfq) REFERENCES rfq (company_id, id);

CREATE TABLE rfq_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  rfq_id uuid NOT NULL,
  line_no int NOT NULL CHECK (line_no > 0),
  item_id uuid NOT NULL,
  qty_base numeric(20,6) NOT NULL CHECK (qty_base > 0),
  preferred_pack_id uuid NULL,
  spec_id uuid NULL,
  notes text NULL,
  UNIQUE (company_id, rfq_id, line_no),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, rfq_id) REFERENCES rfq (company_id, id),
  FOREIGN KEY (company_id, item_id) REFERENCES item (company_id, id),
  FOREIGN KEY (company_id, preferred_pack_id) REFERENCES item_pack (company_id, id)
);

CREATE TABLE rfq_recipient (
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  rfq_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  contact_id uuid NULL,
  status text NOT NULL DEFAULT 'to_contact' CHECK (status IN
    ('to_contact','contacted','replied','quoted','declined','no_response','disqualified')),
  first_contacted_at timestamptz NULL,
  last_contacted_at timestamptz NULL,
  last_reply_at timestamptz NULL,
  follow_ups int NOT NULL DEFAULT 0,
  status_note text NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, rfq_id, supplier_id),
  FOREIGN KEY (company_id, rfq_id) REFERENCES rfq (company_id, id),
  FOREIGN KEY (company_id, supplier_id) REFERENCES supplier (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contact (company_id, id)
);

CREATE TABLE interaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  supplier_id uuid NOT NULL,
  contact_id uuid NULL,
  contact_method_id uuid NULL,
  rfq_id uuid NULL,
  direction text NOT NULL CHECK (direction IN ('out','in')),
  channel text NOT NULL CHECK (channel IN ('email','phone','whatsapp','line','wechat','telegram','sms','web_form',
    'portal','visit','video_call','other')),
  purpose text NULL CHECK (purpose IN ('rfq','follow_up','spec_request','negotiation','order','complaint','intro','other')),
  our_address text NULL,
  their_address text NULL,
  subject text NULL,
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  external_thread_id text NULL,
  occurred_at timestamptz NOT NULL,
  logged_by uuid NOT NULL REFERENCES app_user,
  via_agent boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, supplier_id) REFERENCES supplier (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contact (company_id, id),
  FOREIGN KEY (company_id, contact_method_id) REFERENCES contact_method (company_id, id),
  FOREIGN KEY (company_id, rfq_id) REFERENCES rfq (company_id, id)
);
CREATE INDEX interaction_supplier ON interaction (company_id, supplier_id, occurred_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rfq','rfq_line','rfq_recipient','interaction'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id())
                    WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON rfq, rfq_line TO sim_app;
GRANT UPDATE (status, status_note) ON rfq TO sim_app;
GRANT UPDATE (spec_id) ON rfq_line TO sim_app;
GRANT SELECT, INSERT, UPDATE ON rfq_recipient TO sim_app;
GRANT SELECT, INSERT ON interaction TO sim_app;
