-- Specs as versioned text (documents attach through document_link) and Claude's logged verdicts.

CREATE TABLE item_spec (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  item_id uuid NOT NULL,
  version int NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft','active','superseded')),
  body_md text NOT NULL CHECK (length(body_md) BETWEEN 1 AND 50000),
  approved_by uuid NULL REFERENCES app_user,
  effective_from date NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, item_id, version),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, item_id) REFERENCES item (company_id, id)
);
CREATE UNIQUE INDEX item_spec_one_active ON item_spec (company_id, item_id) WHERE status = 'active';

ALTER TABLE rfq_line ADD FOREIGN KEY (company_id, spec_id) REFERENCES item_spec (company_id, id);

CREATE TABLE evaluation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  subject_type text NOT NULL CHECK (subject_type IN ('quote','quote_line','lot','supplier_item','supplier')),
  subject_id uuid NOT NULL,
  spec_id uuid NULL,
  verdict text NOT NULL CHECK (verdict IN ('good','not_good','needs_info')),
  reasoning text NOT NULL CHECK (length(reasoning) BETWEEN 10 AND 8000),
  evidence_document_ids uuid[] NOT NULL DEFAULT '{}',
  decided_by uuid NOT NULL REFERENCES app_user,
  via_agent boolean NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  supersedes_id uuid NULL,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, spec_id) REFERENCES item_spec (company_id, id),
  FOREIGN KEY (company_id, supersedes_id) REFERENCES evaluation (company_id, id)
);
CREATE INDEX evaluation_subject ON evaluation (company_id, subject_type, subject_id, decided_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['item_spec','evaluation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id())
                    WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON item_spec, evaluation TO sim_app;
GRANT UPDATE (status) ON item_spec TO sim_app;
