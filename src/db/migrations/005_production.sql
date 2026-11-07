-- Bills of materials (recipes in process plants) and production runs (batches, work orders).

CREATE TABLE bom (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  output_item_id uuid NOT NULL,
  version int NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','retired')),
  batch_qty_base numeric(20,6) NOT NULL CHECK (batch_qty_base > 0),
  expected_yield numeric(7,6) NULL CHECK (expected_yield > 0 AND expected_yield <= 1),
  notes text NULL,
  created_by uuid NULL REFERENCES app_user,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, output_item_id, version),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, output_item_id) REFERENCES item (company_id, id)
);
CREATE UNIQUE INDEX bom_one_active ON bom (company_id, output_item_id) WHERE status = 'active';

CREATE TABLE bom_line (
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  bom_id uuid NOT NULL,
  line_no int NOT NULL CHECK (line_no > 0),
  item_id uuid NOT NULL,
  qty_base numeric(20,6) NOT NULL CHECK (qty_base > 0),
  scrap_factor numeric(7,6) NOT NULL DEFAULT 0 CHECK (scrap_factor >= 0 AND scrap_factor < 10),
  scales_with_batch boolean NOT NULL DEFAULT true,
  PRIMARY KEY (company_id, bom_id, line_no),
  UNIQUE (company_id, bom_id, item_id),
  FOREIGN KEY (company_id, bom_id) REFERENCES bom (company_id, id),
  FOREIGN KEY (company_id, item_id) REFERENCES item (company_id, id)
);

CREATE TABLE production_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  bom_id uuid NOT NULL,
  site_id uuid NOT NULL,
  run_code text NOT NULL CHECK (length(run_code) BETWEEN 1 AND 60),
  planned_qty_base numeric(20,6) NOT NULL CHECK (planned_qty_base > 0),
  actual_output_base numeric(20,6) NULL CHECK (actual_output_base >= 0),
  status text NOT NULL CHECK (status IN ('planned','running','done','cancelled')),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  output_lot_id uuid NULL,
  created_by uuid NOT NULL REFERENCES app_user,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, run_code),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, bom_id) REFERENCES bom (company_id, id),
  FOREIGN KEY (company_id, site_id) REFERENCES site (company_id, id),
  FOREIGN KEY (company_id, output_lot_id) REFERENCES lot (company_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bom','bom_line','production_run'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id())
                    WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON bom, bom_line, production_run TO sim_app;
GRANT UPDATE (status) ON bom TO sim_app;
GRANT UPDATE (status, actual_output_base, started_at, finished_at, output_lot_id) ON production_run TO sim_app;
