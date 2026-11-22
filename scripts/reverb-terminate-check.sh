#!/usr/bin/env bash
# LOCAL only. Proves against a real Reverb that a logout closes the user's WebSocket (increment 5.4b, M-3).
#
# Uses the TEST database only (default mediconnect_test; any name not ending in _test is refused) and
# throw-away API and Reverb containers on the compose network, with their own Reverb keys and in-memory
# cache and sessions, so the development database, Redis and the normal api/reverb services are untouched.
# The test database is rebuilt (migrate:fresh), exactly as the Pest suite does.
#
# The API runs on PHP's built-in server, not `artisan serve`: serve drops the environment variables that
# .env also defines, which would silently point the API back at the development database.
#
# Needs: docker compose with postgres and redis running (docker compose up -d postgres redis), Node 22+.
set -euo pipefail
cd "$(dirname "$0")/.."

TEST_DB="${TEST_DB:-mediconnect_test}"
case "$TEST_DB" in *_test) ;; *) echo "Refusing to run against '$TEST_DB': the database name must end in _test." >&2; exit 2 ;; esac

# A cached config ignores the DB_DATABASE override below and would point migrate:fresh at the development database.
if [ -e ../backend/bootstrap/cache/config.php ]; then
  echo "Refusing to run: backend/bootstrap/cache/config.php exists (run 'php artisan config:clear' first)." >&2; exit 2
fi

API_PORT="${API_PORT:-8091}"
WS_PORT="${WS_PORT:-8081}"
API_NAME=mc-reverb-check-api
WS_NAME=mc-reverb-check-reverb
APP_KEY_VALUE="check-$(openssl rand -hex 6)"
APP_SECRET_VALUE="$(openssl rand -hex 16)"
EMAIL="reverb-check@example.test"
PASSWORD="Correct-horse-42"

cleanup() { docker rm -f "$API_NAME" "$WS_NAME" >/dev/null 2>&1 || true; }
[ -n "${KEEP:-}" ] || trap cleanup EXIT
cleanup

ENV_ARGS=(
  -e "DB_DATABASE=$TEST_DB" -e APP_ENV=local
  -e BROADCAST_CONNECTION=reverb -e QUEUE_CONNECTION=sync -e CACHE_STORE=array -e SESSION_DRIVER=array
  -e "REVERB_APP_ID=check-app" -e "REVERB_APP_KEY=$APP_KEY_VALUE" -e "REVERB_APP_SECRET=$APP_SECRET_VALUE"
  -e "REVERB_HOST=$WS_NAME" -e REVERB_PORT=8080 -e REVERB_SCHEME=http
  -e 'REVERB_ALLOWED_ORIGINS=*' # Node's WebSocket sends no first-party Origin; local throw-away only (production refuses '*')
  -e SENTRY_LARAVEL_DSN= -e SENTRY_DSN=
)
PHP=(docker compose run --rm "${ENV_ARGS[@]}" api php artisan)

echo "== Rebuilding the test database ($TEST_DB)"
"${PHP[@]}" migrate:fresh --database=pgsql_owner --force --seed --seeder=RbacSeeder >/dev/null
USER_ID=$("${PHP[@]}" tinker --execute="\$u = app(App\\Modules\\Users\\Contracts\\Accounts::class)->register('$EMAIL', null, '$PASSWORD', ['first_name' => 'Reverb', 'last_name' => 'Check']); app(App\\Modules\\Rbac\\Contracts\\AssignsRoles::class)->assign(\$u, App\\Modules\\Rbac\\Enums\\Role::Patient); echo \$u->id;" | tail -1)
echo "   check user: $USER_ID"

echo "== Starting Reverb and the API (test database, queue sync so the terminate call runs inside the request)"
docker compose run -d --name "$WS_NAME" -p "127.0.0.1:$WS_PORT:8080" "${ENV_ARGS[@]}" api php artisan reverb:start --host=0.0.0.0 --port=8080 >/dev/null
docker compose run -d --name "$API_NAME" -p "127.0.0.1:$API_PORT:8000" "${ENV_ARGS[@]}" api php -S 0.0.0.0:8000 -t public public/index.php >/dev/null
ready=0
for i in $(seq 1 40); do
  if curl -fs "http://127.0.0.1:$API_PORT/api/v1/health" >/dev/null 2>&1 && curl -fs "http://127.0.0.1:$WS_PORT/up" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then echo "The API or Reverb did not become ready within 40 seconds." >&2; exit 1; fi

echo "== Running the check"
API_URL="http://127.0.0.1:$API_PORT/api/v1" WS_URL="ws://127.0.0.1:$WS_PORT" \
  REVERB_APP_KEY="$APP_KEY_VALUE" CHECK_EMAIL="$EMAIL" CHECK_PASSWORD="$PASSWORD" \
  node scripts/reverb-terminate-check.mjs
