-- Who is signed in, with which key, for which company:
-- - a sign-in session remembers the API key that opened it, so revoking the key ends it;
-- - a session has a hard end (30 days after sign-in) however often its tokens are refreshed;
-- - a session records when it was last used;
-- - auth events name the key and the session they concern.
-- Sessions opened before this change do not know their key, so they are ended here (their
-- users sign in again), rather than left running outside key revocation.

ALTER TABLE oauth_code ADD COLUMN api_key_id uuid NULL REFERENCES api_key;

ALTER TABLE oauth_session
  ADD COLUMN api_key_id uuid NULL REFERENCES api_key,
  ADD COLUMN last_used_at timestamptz NULL,
  ADD COLUMN expires_at timestamptz NULL;
UPDATE oauth_session SET revoked_at = now() WHERE revoked_at IS NULL AND api_key_id IS NULL;
UPDATE oauth_session SET expires_at = created_at + interval '30 days';
ALTER TABLE oauth_session ALTER COLUMN expires_at SET NOT NULL;
CREATE INDEX oauth_session_member ON oauth_session (company_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX oauth_session_key ON oauth_session (api_key_id) WHERE revoked_at IS NULL;

ALTER TABLE auth_event
  ADD COLUMN api_key_id uuid NULL,
  ADD COLUMN session_id uuid NULL,
  DROP CONSTRAINT auth_event_kind_check,
  ADD CONSTRAINT auth_event_kind_check CHECK (kind IN ('signin_ok','signin_bad_key','signin_no_membership',
    'signin_rate_limited','token_issued','refresh_rotated','refresh_reused','session_revoked','key_revoked'));
CREATE INDEX auth_event_company ON auth_event (company_id, at DESC);

GRANT UPDATE (last_used_at) ON oauth_session TO sim_app;
