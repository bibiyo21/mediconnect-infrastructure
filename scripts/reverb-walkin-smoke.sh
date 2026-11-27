#!/usr/bin/env bash
# LOCAL live smoke of walk-in realtime against a REAL Reverb (increment 5.6 exit, security gate C3).
#
# Runs on the DEVELOPMENT database only: SMOKE_DB must be exactly `mediconnect` or `mediconnect_smoke`
# (anything else is refused, the Pest database is never touched). It creates SYNTHETIC accounts whose
# emails carry a run tag, and it starts throw-away API and Reverb containers on the compose network with
# their own Reverb keys, so the normal api and reverb services are untouched. Every compose call uses
# --no-deps, so postgres and redis are never recreated; both must already be running.
#
# Service env is pinned (DB_HOST, REDIS_HOST, MAIL_*, SMS_DRIVER) so a backend/.env cannot point the smoke
# at another host. The docker context must be the local unix socket, and DOCKER_HOST must be unset.
#
# Output: docs/recaps/phase-5/evidence/5.6-reverb-smoke.log. The run writes a temp file and replaces the
# evidence log only when the node script has finished (it always writes SUMMARY). An aborted run leaves
# the previous evidence log in place.
#
# Caveats recorded in every log: the sync queue (QUEUE_CONNECTION=sync) means the trailing debounced
# fan-out job is not exercised; the audience filter for a revoked guardian is covered by Pest, not here;
# Sentry is not verified (DSN blanked).
#
# Cleanup of the synthetic rows (NOT run by this script; FK cascades not verified, check before running):
#   delete from users where email like 'walkin-smoke-%@example.test';
#
# No token, password, email, licence number or real data is written to the log.
# Needs: docker compose with postgres and redis running, Node 22+, openssl. Run from any directory.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
INFRA="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$INFRA/.." && pwd)"

SMOKE_DB="${SMOKE_DB:-mediconnect}"
case "$SMOKE_DB" in
  mediconnect|mediconnect_smoke) ;;
  *) echo "Refusing to run against '$SMOKE_DB': only 'mediconnect' or 'mediconnect_smoke' are allowed (never the Pest database)." >&2; exit 2 ;;
esac

if [ -n "${DOCKER_HOST:-}" ]; then
  echo "Refusing to run: DOCKER_HOST is set. The smoke runs only against the local docker socket." >&2; exit 2
fi
DOCKER_ENDPOINT="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
case "$DOCKER_ENDPOINT" in
  unix://*) ;;
  *) echo "Refusing to run: docker context endpoint is not a local unix socket." >&2; exit 2 ;;
esac

# The backend tree the compose file mounts (same resolution as docker-compose.yml, relative to infrastructure/).
BACKEND_DIR="$(cd "$INFRA" && cd "${BACKEND_PATH:-../backend}" && pwd)"
if [ -e "$BACKEND_DIR/bootstrap/cache/config.php" ]; then
  echo "Refusing to run: $BACKEND_DIR/bootstrap/cache/config.php exists (run 'php artisan config:clear' first)." >&2; exit 2
fi

RUNNING_SERVICES="$(cd "$INFRA" && docker compose ps --status running --services 2>/dev/null || true)"
for svc in postgres redis; do
  if ! printf '%s\n' "$RUNNING_SERVICES" | grep -qx "$svc"; then
    echo "Refusing to run: '$svc' is not running. Start the dev stack first (this script never recreates it)." >&2; exit 2
  fi
done

API_PORT="${API_PORT:-8091}"
WS_PORT="${WS_PORT:-8081}"
API_NAME=mc-walkin-smoke-api
WS_NAME=mc-walkin-smoke-reverb
APP_KEY_VALUE="smoke-$(openssl rand -hex 6)"
APP_SECRET_VALUE="$(openssl rand -hex 16)"
SMOKE_TAG="$(openssl rand -hex 3)"
SMOKE_PASSWORD="Smoke-$(openssl rand -hex 12)-A1"
export SMOKE_PASSWORD SMOKE_TAG
LOG="$REPO/docs/recaps/phase-5/evidence/5.6-reverb-smoke.log"
LOG_TMP="$LOG.$SMOKE_TAG.tmp"
mkdir -p "$(dirname "$LOG")"

# Service env pinned for every container this script starts (the node script pins the same list in runPhp).
PIN_ENV=(
  -e "DB_DATABASE=$SMOKE_DB" -e APP_ENV=local
  -e DB_HOST=postgres -e REDIS_HOST=redis
  -e MAIL_MAILER=smtp -e MAIL_HOST=mailpit -e SMS_DRIVER=mail-preview
)

cleanup() {
  docker rm -f "$API_NAME" "$WS_NAME" >/dev/null 2>&1 || true
  rm -f "$LOG_TMP"
}
trap cleanup EXIT
cleanup

ENV_ARGS=(
  "${PIN_ENV[@]}"
  -e BROADCAST_CONNECTION=reverb -e QUEUE_CONNECTION=sync -e SESSION_DRIVER=array
  -e "REVERB_APP_ID=smoke-app" -e "REVERB_APP_KEY=$APP_KEY_VALUE" -e "REVERB_APP_SECRET=$APP_SECRET_VALUE"
  -e "REVERB_HOST=$WS_NAME" -e REVERB_PORT=8080 -e REVERB_SCHEME=http
  -e 'REVERB_ALLOWED_ORIGINS=*' # Node's WebSocket sends no first-party Origin; local throw-away only
  -e SENTRY_LARAVEL_DSN= -e SENTRY_DSN=
)

echo "== Starting Reverb and the API on $SMOKE_DB (queue sync: the fan-out trailing job is not exercised)"
(cd "$INFRA" && docker compose run --no-deps -d --name "$WS_NAME" -p "127.0.0.1:$WS_PORT:8080" "${ENV_ARGS[@]}" api php artisan reverb:start --host=0.0.0.0 --port=8080 >/dev/null)
(cd "$INFRA" && docker compose run --no-deps -d --name "$API_NAME" -p "127.0.0.1:$API_PORT:8000" "${ENV_ARGS[@]}" api php -S 0.0.0.0:8000 -t public public/index.php >/dev/null)
ready=0
for _ in $(seq 1 60); do
  if curl -fs "http://127.0.0.1:$API_PORT/api/v1/health" >/dev/null 2>&1 && curl -fs "http://127.0.0.1:$WS_PORT/up" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then echo "The API or Reverb did not become ready within 60 seconds." >&2; exit 1; fi

echo "== Creating synthetic accounts (tag $SMOKE_TAG)"
PRELUDE='<?php require getcwd().'"'"'/vendor/autoload.php'"'"'; $app = require getcwd().'"'"'/bootstrap/app.php'"'"'; $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();'
SETUP_OUT="$( { printf '%s\n' "$PRELUDE"; sed '1d' "$HERE/reverb-walkin-smoke-setup.php"; } | (cd "$INFRA" && docker compose run --no-deps --rm -T -e SMOKE_PASSWORD -e SMOKE_TAG "${PIN_ENV[@]}" api php))"
SMOKE_IDS="$(printf '%s\n' "$SETUP_OUT" | sed -n 's/^SMOKE_IDS=//p' | tail -1)"
if [ -z "$SMOKE_IDS" ]; then echo "Setup did not print SMOKE_IDS; see the tinker output." >&2; exit 1; fi

TODAY="$(TZ=Asia/Manila date +%Y-%m-%d)" # the clinic's civil date (Asia/Manila)

echo "== Running the walk-in smoke"
set +e
API_URL="http://127.0.0.1:$API_PORT/api/v1" WS_URL="ws://127.0.0.1:$WS_PORT" REVERB_APP_KEY="$APP_KEY_VALUE" \
  SMOKE_PASSWORD="$SMOKE_PASSWORD" SMOKE_IDS="$SMOKE_IDS" SMOKE_DB="$SMOKE_DB" SMOKE_TODAY="$TODAY" \
  INFRA_DIR="$INFRA" LOG_FILE="$LOG_TMP" node "$HERE/reverb-walkin-smoke.mjs"
RC=$?
set -e
if [ -e "$LOG_TMP" ]; then mv "$LOG_TMP" "$LOG"; fi
echo "exit code: $RC (log: $LOG)"
exit "$RC"
