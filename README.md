# mediconnect-infrastructure

Local environment, Docker images, PostgreSQL setup, and later deployment, backup and load-test assets for MediConnect.

## Local environment

Check out `mediconnect-backend` next to this repository (`../backend`), or set `BACKEND_PATH` in `.env`.

```bash
cp .env.example .env   # then replace every change-me value with a random local password
docker compose up -d postgres redis mailpit
```

Services: PostgreSQL 18.1, Redis 8.2, Mailpit, and the PHP 8.4 `api`, `worker` and `scheduler` containers. Typesense, SeaweedFS and ClamAV are default services; Reverb (`--profile realtime`) is optional.

PostgreSQL creates two roles: `mediconnect_owner` runs migrations; `mediconnect_app` is the runtime role. Never commit `.env`.

Specification: [mediconnect-docs](https://github.com/bibiyo21/mediconnect-docs).

## Load tests (LOCAL only)

k6 scripts for the search performance baseline (Phase 3, increment 3.7) live in `load-tests/`. They run in the pinned `grafana/k6:1.3.0` image on the compose network and call the `api` container directly. Never point them at a shared or production environment.

```bash
docker compose exec api php artisan perf:dataset          # 10,000 synthetic doctors, 2,000 locations
docker compose exec api php artisan search:rebuild all
docker run --rm --network mediconnect_default -v "$PWD/load-tests:/scripts:ro" -e MINUTES=10 grafana/k6:1.3.0 run /scripts/search.js
docker compose exec api php artisan search:index-latency --samples=20
docker run --rm --network mediconnect_default -v "$PWD/load-tests:/scripts:ro" grafana/k6:1.3.0 run /scripts/typing.js
docker compose exec api php artisan perf:dataset --remove && docker compose exec api php artisan search:rebuild all
```

- `search.js` stays under the shared 60-a-minute search rate limit (50 a minute), so it measures latency at low load, not throughput. It does not spoof addresses or relax the limit. Samples are split by the API's `meta.cache_hit`; any 429, non-200 or degraded answer fails the run.
- `typing.js` shows how many typing pauses (two requests each) one patient gets before the limit answers 429. Wait a minute after another run so the bucket starts empty.
- Run one thing at a time, and nothing else heavy on the machine. Results and their limits are recorded in `mediconnect-docs/docs/performance-testing.md`.
