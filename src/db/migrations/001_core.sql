-- Core: companies, users, sign-in, OAuth bookkeeping, tool audit, operation journal.
-- Runs as sim_owner. Roles sim_app and sim_read must already exist.

-- The current company for row-level security. NULL when not set, so policies match nothing.
CREATE FUNCTION app_company_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.company_id', true), '')::uuid $$;

ALTER DEFAULT PRIVILEGES FOR ROLE sim_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sim_app;

CREATE TABLE company (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE brand (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  name text NOT NULL,
  UNIQUE (company_id, name)
);

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  disabled_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE membership (
  user_id uuid NOT NULL REFERENCES app_user,
  company_id uuid NOT NULL REFERENCES company,
  scopes text[] NOT NULL CHECK (scopes <@ ARRAY['read','write','approve'] AND 'read' = ANY (scopes)),
  disabled_at timestamptz NULL,
  PRIMARY KEY (user_id, company_id)
);

CREATE TABLE api_key (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user,
  key_hmac text NOT NULL UNIQUE,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NULL,
  revoked_at timestamptz NULL
);

CREATE TABLE oauth_client (
  client_id text PRIMARY KEY,
  client_name text NULL,
  redirect_uris text[] NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_pending (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL REFERENCES oauth_client,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  state text NULL,
  scopes text[] NOT NULL,
  resource text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL
);

CREATE TABLE oauth_code (
  code_hmac text PRIMARY KEY,
  pending_id uuid NOT NULL REFERENCES oauth_pending,
  user_id uuid NOT NULL REFERENCES app_user,
  company_id uuid NOT NULL REFERENCES company,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL
);

CREATE TABLE oauth_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user,
  company_id uuid NOT NULL REFERENCES company,
  client_id text NOT NULL REFERENCES oauth_client,
  scopes text[] NOT NULL,
  resource text NOT NULL,
  access_hmac text NOT NULL UNIQUE,
  access_expires_at timestamptz NOT NULL,
  refresh_hmac text NOT NULL UNIQUE,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_used_refresh (
  refresh_hmac text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES oauth_session,
  used_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_event (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('signin_ok','signin_bad_key','signin_no_membership',
    'signin_rate_limited','token_issued','refresh_rotated','refresh_reused','session_revoked')),
  user_id uuid NULL,
  company_id uuid NULL,
  client_id text NULL,
  ip text NULL
);

-- One row per tool call or HTTPS request, written before anything runs.
CREATE TABLE tool_audit (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  user_id uuid NOT NULL REFERENCES app_user,
  session_id uuid NOT NULL,
  client text NOT NULL,
  tool text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  code_sha256 text NULL,
  started_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_audit_recent ON tool_audit (company_id, started_at DESC);

CREATE TABLE tool_audit_outcome (
  tool_audit_id uuid PRIMARY KEY REFERENCES tool_audit,
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  finished_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN ('ok','error')),
  operations_called int NOT NULL,
  error_kind text NULL
);

CREATE TABLE operation_journal (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES company,
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  tool_audit_id uuid NOT NULL REFERENCES tool_audit,
  operation text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('read','write')),
  reason text NULL,
  request_key text NULL,
  args_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('started','completed','failed')),
  result jsonb NULL,
  error_code text NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  CHECK (kind = 'read' OR (reason IS NOT NULL AND request_key IS NOT NULL)),
  UNIQUE (company_id, request_key)
);
CREATE INDEX operation_journal_audit ON operation_journal (tool_audit_id);

-- Tenant tables: row-level security enabled and forced (applies to the owner too).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['brand','tool_audit','tool_audit_outcome','operation_journal'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id())
                    WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT ON company TO sim_app;
GRANT SELECT, INSERT, UPDATE ON brand TO sim_app;
GRANT SELECT ON app_user, membership TO sim_app;
GRANT SELECT, UPDATE (last_used_at) ON api_key TO sim_app;
GRANT SELECT, INSERT ON oauth_client TO sim_app;
GRANT SELECT, INSERT, UPDATE (used_at) ON oauth_pending, oauth_code TO sim_app;
GRANT SELECT, INSERT, UPDATE (access_hmac, access_expires_at, refresh_hmac, revoked_at)
  ON oauth_session TO sim_app;
GRANT SELECT, INSERT ON oauth_used_refresh, auth_event, tool_audit, tool_audit_outcome TO sim_app;
GRANT SELECT, INSERT, UPDATE (status, result, error_code, finished_at) ON operation_journal TO sim_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sim_app;
GRANT EXECUTE ON FUNCTION app_company_id() TO sim_app, sim_read;
