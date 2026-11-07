-- Items, units, containers, packs, identifiers, sites and locations, and the document store.
-- Child tables reference parents through (company_id, id) so cross-company links are impossible.

ALTER TABLE brand ADD CONSTRAINT brand_company_id_id UNIQUE (company_id, id);

-- Global units. to_si: how many of the dimension's SI unit one of this unit is (kg, L, m, m2, each).
CREATE TABLE uom (
  code text PRIMARY KEY,
  dimension text NOT NULL CHECK (dimension IN ('count','mass','volume','length','area')),
  to_si numeric NOT NULL CHECK (to_si > 0),
  name text NOT NULL
);
INSERT INTO uom (code, dimension, to_si, name) VALUES
  ('each', 'count', 1, 'each'),
  ('mg', 'mass', 0.000001, 'milligram'), ('g', 'mass', 0.001, 'gram'), ('kg', 'mass', 1, 'kilogram'),
  ('t', 'mass', 1000, 'tonne'), ('lb', 'mass', 0.45359237, 'pound'), ('oz', 'mass', 0.028349523125, 'ounce'),
  ('mL', 'volume', 0.001, 'millilitre'), ('L', 'volume', 1, 'litre'), ('m3', 'volume', 1000, 'cubic metre'),
  ('gal_us', 'volume', 3.785411784, 'US gallon'), ('gal_uk', 'volume', 4.54609, 'imperial gallon'),
  ('mm', 'length', 0.001, 'millimetre'), ('cm', 'length', 0.01, 'centimetre'), ('m', 'length', 1, 'metre'),
  ('km', 'length', 1000, 'kilometre'), ('in', 'length', 0.0254, 'inch'), ('ft', 'length', 0.3048, 'foot'),
  ('m2', 'area', 1, 'square metre'), ('ft2', 'area', 0.09290304, 'square foot');

CREATE TABLE container_type (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NULL DEFAULT app_company_id() REFERENCES company,
  kind text NOT NULL CHECK (kind IN ('drum','ibc','sack','bulk_bag','box','case','carton','pallet','bottle',
    'can','keg','cylinder','pail','jerrycan','roll','spool','reel','tote','bulk','other')),
  name text NOT NULL,
  nominal_capacity numeric(20,6) NULL CHECK (nominal_capacity > 0),
  capacity_uom text NULL REFERENCES uom,
  is_returnable boolean NOT NULL DEFAULT false,
  deposit_amount numeric(20,6) NULL,
  deposit_currency char(3) NULL
);
CREATE UNIQUE INDEX container_type_name ON container_type (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
-- Global seeds (company_id NULL), inserted before row-level security is switched on.
INSERT INTO container_type (company_id, kind, name, nominal_capacity, capacity_uom, is_returnable) VALUES
  (NULL, 'drum', 'Drum', NULL, NULL, false), (NULL, 'drum', '200 L drum', 200, 'L', false),
  (NULL, 'ibc', '1000 L IBC tote', 1000, 'L', true), (NULL, 'jerrycan', '25 L jerrycan', 25, 'L', false),
  (NULL, 'pail', '20 L pail', 20, 'L', false), (NULL, 'sack', 'Sack', NULL, NULL, false),
  (NULL, 'sack', '25 kg sack', 25, 'kg', false), (NULL, 'bulk_bag', '1 t bulk bag', 1000, 'kg', false),
  (NULL, 'box', 'Box', NULL, NULL, false), (NULL, 'case', 'Case', NULL, NULL, false),
  (NULL, 'carton', 'Carton', NULL, NULL, false), (NULL, 'pallet', 'Pallet', NULL, NULL, false),
  (NULL, 'bottle', 'Bottle', NULL, NULL, false), (NULL, 'can', 'Can', NULL, NULL, false),
  (NULL, 'keg', '50 L keg', 50, 'L', true), (NULL, 'cylinder', 'Gas cylinder', NULL, NULL, true),
  (NULL, 'roll', 'Roll', NULL, NULL, false), (NULL, 'spool', 'Spool', NULL, NULL, false),
  (NULL, 'reel', 'Reel', NULL, NULL, false), (NULL, 'tote', 'Tote', NULL, NULL, false),
  (NULL, 'bulk', 'Bulk (tank or silo)', NULL, NULL, false), (NULL, 'other', 'Other', NULL, NULL, false);

CREATE TABLE item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  brand_id uuid NULL,
  sku text NOT NULL CHECK (length(sku) BETWEEN 1 AND 80),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  category text NOT NULL CHECK (category IN ('raw_material','ingredient','packaging','component','wip',
    'finished_good','consumable','mro_spare','chemical','tooling','other')),
  physical_form text NOT NULL CHECK (physical_form IN ('discrete','powder','granular','liquid','gas','paste',
    'sheet','bar_profile','coil','roll_goods')),
  sourcing_type text NOT NULL CHECK (sourcing_type IN ('commodity','catalog','made_to_print','service')),
  base_uom text NOT NULL REFERENCES uom,
  is_lot_tracked boolean NOT NULL DEFAULT false,
  shelf_life_days int NULL CHECK (shelf_life_days > 0),
  hazmat_class text NULL,
  storage_notes text NULL,
  attributes jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','phase_out','obsolete')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, sku),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, brand_id) REFERENCES brand (company_id, id)
);
CREATE INDEX item_name_search ON item (company_id, lower(name));

CREATE TABLE item_uom_conversion (
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  item_id uuid NOT NULL,
  from_uom text NOT NULL REFERENCES uom,
  to_uom text NOT NULL REFERENCES uom,
  factor numeric NOT NULL CHECK (factor > 0),
  PRIMARY KEY (company_id, item_id, from_uom, to_uom),
  FOREIGN KEY (company_id, item_id) REFERENCES item (company_id, id)
);

CREATE TABLE document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  kind text NOT NULL CHECK (kind IN ('spec_sheet','drawing','sds','coa','mill_cert','coc','quote','invoice',
    'certificate','email','photo','note','other')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  mime text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_backend text NULL CHECK (storage_backend IN ('gcs','local')),
  storage_key text NULL,
  text_content text NULL,
  text_source text NOT NULL CHECK (text_source IN ('extracted','claude','none')),
  source text NOT NULL CHECK (source IN ('mail','upload','url','note')),
  source_ref text NULL CHECK (length(source_ref) <= 1000),
  valid_until date NULL,
  scan_status text NOT NULL CHECK (scan_status IN ('clean','not_scanned')),
  captured_by uuid NULL REFERENCES app_user,
  captured_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS
    (to_tsvector('simple', title || ' ' || left(coalesce(text_content, ''), 400000))) STORED,
  UNIQUE (company_id, sha256),
  UNIQUE (company_id, id),
  CHECK ((storage_key IS NULL) = (storage_backend IS NULL))
);
CREATE INDEX document_search ON document USING gin (search);

CREATE TABLE document_link (
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  document_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('item','item_spec','supplier','contact','rfq','quote',
    'lot','purchase_order','production_run','wiki_page','interaction','evaluation')),
  entity_id uuid NOT NULL,
  role text NULL CHECK (length(role) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, document_id, entity_type, entity_id),
  FOREIGN KEY (company_id, document_id) REFERENCES document (company_id, id)
);
CREATE INDEX document_link_entity ON document_link (company_id, entity_type, entity_id);

CREATE TABLE item_identifier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  item_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('mpn','cas','drawing','standard','hs_code','gtin','alias')),
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 120),
  manufacturer text NULL,
  revision text NULL,
  document_id uuid NULL,
  is_primary boolean NOT NULL DEFAULT false,
  UNIQUE (company_id, item_id, kind, value),
  FOREIGN KEY (company_id, item_id) REFERENCES item (company_id, id),
  FOREIGN KEY (company_id, document_id) REFERENCES document (company_id, id)
);
CREATE INDEX item_identifier_value ON item_identifier (company_id, lower(value));

CREATE TABLE item_pack (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  item_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  container_type_id uuid NULL REFERENCES container_type,
  contains_pack_id uuid NULL,
  contains_qty numeric(20,6) NOT NULL CHECK (contains_qty > 0),
  base_qty numeric(20,6) NOT NULL CHECK (base_qty > 0),
  barcode text NULL,
  is_default_receive boolean NOT NULL DEFAULT false,
  is_default_issue boolean NOT NULL DEFAULT false,
  UNIQUE (company_id, item_id, name),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, item_id) REFERENCES item (company_id, id),
  FOREIGN KEY (company_id, contains_pack_id) REFERENCES item_pack (company_id, id)
);

CREATE TABLE site (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$'),
  name text NOT NULL,
  address text NULL,
  timezone text NOT NULL,
  UNIQUE (company_id, code),
  UNIQUE (company_id, id)
);

CREATE TABLE location (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  site_id uuid NOT NULL,
  parent_id uuid NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$'),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('zone','rack','bin','tank','silo','cold_room','line','receiving',
    'quarantine','in_transit','shipping','yard')),
  capacity numeric(20,6) NULL,
  capacity_uom text NULL REFERENCES uom,
  UNIQUE (company_id, site_id, code),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, site_id) REFERENCES site (company_id, id),
  FOREIGN KEY (company_id, parent_id) REFERENCES location (company_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['item','item_uom_conversion','document','document_link','item_identifier',
                           'item_pack','site','location'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id())
                    WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

ALTER TABLE container_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE container_type FORCE ROW LEVEL SECURITY;
CREATE POLICY shared_or_own ON container_type
  USING (company_id IS NULL OR company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT ON uom TO sim_app;
GRANT SELECT, INSERT, UPDATE ON container_type, item, item_uom_conversion, item_identifier, item_pack, site, location TO sim_app;
GRANT SELECT, INSERT ON document, document_link TO sim_app;
GRANT UPDATE (title, valid_until) ON document TO sim_app;
