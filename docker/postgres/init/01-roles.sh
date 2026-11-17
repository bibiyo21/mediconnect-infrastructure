#!/bin/sh
# Local/dev only. Creates two roles (architecture: append-only tables are protected
# by denying UPDATE/DELETE to the application role):
#   - $DB_OWNER_USER : owns the schema, runs migrations
#   - $DB_APP_USER   : runtime role used by the API, workers and tests
# and two databases: the main one and a test one.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE ${DB_OWNER_USER} LOGIN PASSWORD '${DB_OWNER_PASSWORD}';
CREATE ROLE ${DB_APP_USER}   LOGIN PASSWORD '${DB_APP_PASSWORD}';
SQL

for db in "${DB_DATABASE}" "${DB_DATABASE}_test"; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE DATABASE ${db} OWNER ${DB_OWNER_USER};
SQL
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "${db}" <<SQL
-- Extensions need superuser on first install; created here, used by migrations.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO ${DB_OWNER_USER};
GRANT USAGE ON SCHEMA public TO ${DB_APP_USER};
GRANT CONNECT ON DATABASE ${db} TO ${DB_APP_USER};

-- Everything the owner creates is usable by the app role by default.
-- Append-only tables revoke UPDATE/DELETE from the app role in their own migration.
ALTER DEFAULT PRIVILEGES FOR ROLE ${DB_OWNER_USER} IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${DB_APP_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${DB_OWNER_USER} IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ${DB_APP_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${DB_OWNER_USER} IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO ${DB_APP_USER};
SQL
done
