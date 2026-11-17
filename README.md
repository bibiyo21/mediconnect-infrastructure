# mediconnect-infrastructure

Local environment, Docker images, PostgreSQL setup, and later deployment, backup and load-test assets for MediConnect.

## Local environment

Check out `mediconnect-backend` next to this repository (`../backend`), or set `BACKEND_PATH` in `.env`.

```bash
cp .env.example .env   # then replace every change-me value with a random local password
docker compose up -d postgres redis mailpit
```

Services: PostgreSQL 18.1, Redis 8.2, Mailpit, and the PHP 8.4 `api`, `worker` and `scheduler` containers. Typesense (`--profile search`) and Reverb (`--profile realtime`) are optional.

PostgreSQL creates two roles: `mediconnect_owner` runs migrations; `mediconnect_app` is the runtime role. Never commit `.env`.

Specification: [mediconnect-docs](https://github.com/bibiyo21/mediconnect-docs).
