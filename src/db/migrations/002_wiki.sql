-- Per-company wiki: maintained pages, full revision history, derived links, activity log.
-- The raw layer (source files) is the document table.

CREATE TABLE wiki_page (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  brand_id uuid NULL REFERENCES brand,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,80}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  page_type text NOT NULL CHECK (page_type IN
    ('index','current_status','rules','project','supplier','item','topic','decision','meeting')),
  entity_type text NULL CHECK (entity_type IN ('supplier','item','rfq','quote','po','lot','doc')),
  entity_id uuid NULL,
  body_md text NOT NULL CHECK (length(body_md) <= 200000),
  summary text NULL CHECK (length(summary) <= 500),
  tags text[] NOT NULL DEFAULT '{}',
  revision int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES app_user,
  search tsvector GENERATED ALWAYS AS
    (to_tsvector('simple', title || ' ' || coalesce(summary, '') || ' ' || body_md)) STORED,
  UNIQUE (company_id, slug),
  CHECK ((entity_type IS NULL) = (entity_id IS NULL))
);
CREATE INDEX wiki_page_search ON wiki_page USING gin (search);
CREATE UNIQUE INDEX wiki_page_entity ON wiki_page (company_id, entity_type, entity_id) WHERE entity_id IS NOT NULL;

CREATE TABLE wiki_revision (
  page_id uuid NOT NULL REFERENCES wiki_page,
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  revision int NOT NULL,
  title text NOT NULL,
  body_md text NOT NULL,
  edit_summary text NULL,
  author_user_id uuid NULL REFERENCES app_user,
  via_agent boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, revision)
);

CREATE TABLE wiki_link (
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  from_page_id uuid NOT NULL REFERENCES wiki_page,
  to_slug text NULL,
  to_entity_type text NULL,
  to_entity_id uuid NULL,
  CHECK (to_slug IS NOT NULL OR to_entity_id IS NOT NULL)
);
CREATE INDEX wiki_link_from ON wiki_link (from_page_id);

CREATE TABLE wiki_log (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL CHECK (action IN ('ingest','edit','decision','lint','query_writeback','note')),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  page_slugs text[] NOT NULL DEFAULT '{}',
  document_ids uuid[] NOT NULL DEFAULT '{}',
  actor_user_id uuid NULL REFERENCES app_user,
  via_agent boolean NOT NULL
);
CREATE INDEX wiki_log_recent ON wiki_log (company_id, at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wiki_page','wiki_revision','wiki_link','wiki_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id())
                    WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON wiki_page TO sim_app;
GRANT SELECT, INSERT ON wiki_revision, wiki_log TO sim_app;
GRANT SELECT, INSERT, DELETE ON wiki_link TO sim_app;
GRANT USAGE, SELECT ON SEQUENCE wiki_log_id_seq TO sim_app;
