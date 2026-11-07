-- The server keeps no files. A document is its details, the text Claude read from it, and a
-- location: where the file really is (a path on the machine of the person who saved it, or a
-- link). Claude opens the file there with its own tools.
-- Rows made by earlier uploads keep their sha256 and text; the file copies they pointed at are
-- no longer reachable through the server.

ALTER TABLE document
  ADD COLUMN location text NULL CHECK (length(location) BETWEEN 1 AND 2000),
  ALTER COLUMN mime DROP NOT NULL,
  ALTER COLUMN size_bytes DROP NOT NULL,
  ALTER COLUMN sha256 DROP NOT NULL,
  DROP CONSTRAINT document_check,
  DROP COLUMN storage_backend,
  DROP COLUMN storage_key,
  DROP COLUMN scan_status,
  DROP CONSTRAINT document_source_check,
  ADD CONSTRAINT document_source_check CHECK (source IN ('mail', 'note', 'file', 'url', 'upload'));

CREATE INDEX document_location ON document (company_id, location);

GRANT UPDATE (title, kind, location, text_content, text_source, valid_until) ON document TO sim_app;
GRANT SELECT (location) ON document TO sim_read;
