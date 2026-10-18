#!/usr/bin/env bash
set -euo pipefail

# Only the official image's first initialization runs this file. The password
# enters psql through stdin, never through process arguments or environment.
app_password=$(< /run/secrets/hasi-postgres-app-password)
if [[ ! "$app_password" =~ ^[A-Za-z0-9_-]{32,}$ ]]; then
  printf 'Invalid HASI PostgreSQL application password format.\n' >&2
  exit 1
fi

psql --no-psqlrc --username postgres --dbname hasi --set ON_ERROR_STOP=1 <<SQL
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
CREATE ROLE hasi LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '$app_password';
ALTER DATABASE hasi OWNER TO hasi;
SQL
unset app_password
