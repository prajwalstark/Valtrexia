#!/bin/sh
# Runs once, when the Postgres data volume is first created.
#
# Creates valtrexia_app, the role the web app and worker connect as. It is
# deliberately weak: not a superuser, cannot bypass row-level security, and
# owns no tables. Table privileges are granted by the migrations.
#
# Not using Docker? Run the same statement yourself; see README.md.
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$APP_DB_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE valtrexia_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'valtrexia_app')
\gexec
SQL
