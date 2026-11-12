#!/bin/sh
# Runs once, when the Postgres data volume is first created.
#
# Creates the runtime role the web app and worker connect as. It is
# deliberately weak: not a superuser, cannot bypass row-level security, and
# does not own any tables. Table privileges are granted by the migrations.
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_user="$APP_DB_USER" -v app_password="$APP_DB_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
  :'app_user', :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec
SQL
