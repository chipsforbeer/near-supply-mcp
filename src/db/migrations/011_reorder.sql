-- Reorder policies per item and site; the low-stock report reads these with the ledger.

CREATE TABLE reorder_policy (
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  item_id uuid NOT NULL,
  site_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('min_max','days_of_cover','manual')),
  min_qty_base numeric(20,6) NULL CHECK (min_qty_base >= 0),
  max_qty_base numeric(20,6) NULL CHECK (max_qty_base > 0),
  safety_days numeric(8,2) NULL CHECK (safety_days >= 0),
  target_cover_days numeric(8,2) NULL CHECK (target_cover_days > 0),
  lead_time_override int NULL CHECK (lead_time_override >= 0),
  usage_window_days int NOT NULL DEFAULT 30 CHECK (usage_window_days BETWEEN 7 AND 365),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, item_id, site_id),
  CHECK (method <> 'min_max' OR (min_qty_base IS NOT NULL AND max_qty_base IS NOT NULL AND min_qty_base <= max_qty_base)),
  CHECK (method <> 'days_of_cover' OR (safety_days IS NOT NULL AND target_cover_days IS NOT NULL)),
  FOREIGN KEY (company_id, item_id) REFERENCES item (company_id, id),
  FOREIGN KEY (company_id, site_id) REFERENCES site (company_id, id)
);

ALTER TABLE reorder_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE reorder_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON reorder_policy USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON reorder_policy TO sim_app;
