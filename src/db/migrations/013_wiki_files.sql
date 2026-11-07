-- The wiki becomes Markdown files. Every page is addressed by a path such as
-- suppliers/acme-metals.md (folders are path prefixes), deleted pages are kept with
-- status 'deleted', revisions record the path, what happened and the write's reason,
-- and the activity log is the page log.md instead of a table.
-- Existing pages keep their name: slug becomes slug.md, so [[slug]] links still resolve.
-- Row-level security is lifted for the owner only while existing rows are converted.

ALTER TABLE wiki_page NO FORCE ROW LEVEL SECURITY;
ALTER TABLE wiki_revision NO FORCE ROW LEVEL SECURITY;
ALTER TABLE wiki_link NO FORCE ROW LEVEL SECURITY;
ALTER TABLE wiki_log NO FORCE ROW LEVEL SECURITY;

-- Pages
ALTER TABLE wiki_page DROP COLUMN search;
ALTER TABLE wiki_page DROP CONSTRAINT wiki_page_status_check;
ALTER TABLE wiki_page ADD COLUMN path text;
UPDATE wiki_page SET path = slug || '.md', status = CASE WHEN status = 'archived' THEN 'deleted' ELSE status END;
ALTER TABLE wiki_page
  ALTER COLUMN path SET NOT NULL,
  ADD CONSTRAINT wiki_page_path_check CHECK (
    length(path) <= 200
    AND path ~ '^([a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*/){0,5}[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*\.md$'),
  ADD CONSTRAINT wiki_page_status_check CHECK (status IN ('active', 'deleted'));
ALTER TABLE wiki_page DROP COLUMN slug, DROP COLUMN page_type, DROP COLUMN summary, DROP COLUMN tags;
DROP INDEX wiki_page_entity;
CREATE UNIQUE INDEX wiki_page_entity ON wiki_page (company_id, entity_type, entity_id)
  WHERE entity_id IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX wiki_page_path ON wiki_page (company_id, path) WHERE status = 'active';
ALTER TABLE wiki_page ADD COLUMN search tsvector GENERATED ALWAYS AS
  (to_tsvector('simple', title || ' ' || translate(path, '/._-', '    ') || ' ' || body_md)) STORED;
CREATE INDEX wiki_page_search ON wiki_page USING gin (search);

-- Revisions
ALTER TABLE wiki_revision ADD COLUMN path text, ADD COLUMN action text;
UPDATE wiki_revision r
   SET path = p.path, action = CASE WHEN r.revision = 1 THEN 'create' ELSE 'edit' END
  FROM wiki_page p WHERE p.id = r.page_id;
ALTER TABLE wiki_revision
  ALTER COLUMN path SET NOT NULL,
  ALTER COLUMN action SET NOT NULL,
  ADD CONSTRAINT wiki_revision_action_check CHECK (action IN ('create', 'edit', 'move', 'delete', 'restore'));
ALTER TABLE wiki_revision RENAME COLUMN edit_summary TO reason;

-- Links point at paths
ALTER TABLE wiki_link RENAME COLUMN to_slug TO to_path;
UPDATE wiki_link SET to_path = to_path || '.md' WHERE to_path IS NOT NULL;
CREATE INDEX wiki_link_to_path ON wiki_link (company_id, to_path) WHERE to_path IS NOT NULL;

-- The activity log becomes log.md, one line per event, oldest first. A company that already
-- has a page named log makes this fail (unique path), rather than losing either.
INSERT INTO wiki_page (company_id, path, title, body_md)
SELECT company_id, 'log.md', 'Log',
       E'# Log\n\nOne line per event, newest last: date, action, summary, pages, documents.\n'
       || string_agg(format('- %s | %s | %s', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), action,
                            replace(summary, E'\n', ' ')), E'\n' ORDER BY at, id) || E'\n'
  FROM wiki_log GROUP BY company_id;
INSERT INTO wiki_revision (page_id, company_id, revision, path, title, body_md, action, reason, author_user_id, via_agent)
SELECT p.id, p.company_id, 1, p.path, p.title, p.body_md, 'create', 'converted from the activity log table', NULL, false
  FROM wiki_page p
 WHERE p.path = 'log.md' AND NOT EXISTS (SELECT 1 FROM wiki_revision r WHERE r.page_id = p.id);
DROP TABLE wiki_log;

ALTER TABLE wiki_page FORCE ROW LEVEL SECURITY;
ALTER TABLE wiki_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE wiki_link FORCE ROW LEVEL SECURITY;

-- sql_query may read the new path column (the search column stays internal).
GRANT SELECT (path) ON wiki_page TO sim_read;
