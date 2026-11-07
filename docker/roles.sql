-- The server's three database roles and its database. Run once as a Postgres superuser before the
-- first migration. docker compose does this for the demo (docker/init-roles.sh). Without Docker:
--   psql "postgres://postgres:<password>@127.0.0.1:5432/postgres" \
--        -v owner_password=demo-only-owner -v app_password=demo-only-app -v read_password=demo-only-read \
--        -v dbname=supplier_inventory -f docker/roles.sql
-- Demo-only passwords are fine for a local demo; never commit real ones.

CREATE ROLE sim_owner LOGIN PASSWORD :'owner_password';
CREATE ROLE sim_app LOGIN PASSWORD :'app_password';
CREATE ROLE sim_read LOGIN PASSWORD :'read_password';

CREATE DATABASE :"dbname" OWNER sim_owner;
\connect :"dbname"
GRANT USAGE ON SCHEMA public TO sim_app, sim_read;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
