#!/bin/sh
# Runs once when the demo database volume is first created (postgres image init hook).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_password="$SIM_OWNER_PASSWORD" \
  -v app_password="$SIM_APP_PASSWORD" \
  -v read_password="$SIM_READ_PASSWORD" \
  -v dbname="$SIM_DB" \
  -f /docker-roles.sql
