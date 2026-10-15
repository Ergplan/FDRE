# Operations

## Components

| Process | Command | Notes |
|---|---|---|
| PostgreSQL 16 | system service, or `docker compose up db` (Day 7 compose file) | databases `fdre` (app) and `fdre_test` (tests), role `fdre` |
| API | `make api` → `uvicorn fdre_platform.api.app:app --port 8000` | `/api/v1/*` platform routes, `/api/v1/docs` OpenAPI UI, legacy `/api/*` workspace routes and the built React app mounted underneath |
| Worker | `make worker` → `python -m fdre_platform.worker` | claims jobs from the `job` table (SKIP LOCKED, 10-minute lease, 3 attempts with backoff); run several for throughput |
| Web (dev) | `make web` → Vite on :5173 proxying `/api` to :8000 | production serves `react_demo/dist` from the API process |

## First start

```sh
make venv                       # Python 3.12 + requirements.txt + requirements-platform.txt
cp .env.example .env            # set DATABASE_URL, DATA_DIR; keys stay out of git
make migrate                    # alembic upgrade head
make bootstrap EMAIL=you@org.test PASSWORD='choose-a-long-one' ORG=ergplan ORG_NAME='Ergplan'
.venv/bin/python -m fdre_platform.cli add-user --org-slug ergplan --email eng@org.test --name "Engineer" --password ... --role engineer
make api & make worker &
cd react_demo && npm ci && npm run build   # or npm run dev for live reload
```

Roles: administrator, bid_manager, engineer, finance_reviewer, approver, viewer. The matrix is `fdre_platform/permissions.py`.

## tender_engine

Set `TENDER_ENGINE_URL` (and `TENDER_ENGINE_ADMIN_TOKEN`) to a live instance; the platform talks to it over HTTP only (`fdre_platform/integrations/tender_engine.py`). Without a URL the adapter answers from recorded fixtures and labels everything `fixture`. A local instance for development: clone `Ergplan/tender_engine`, install its `pyproject.toml` dependencies in a separate venv, create a database, run its `alembic upgrade head` and start `uvicorn api.main:create_app --factory --port 8100` with its `DATABASE_URL`, `DATA_DIR`, `TENANT_ID`, `PUBLIC_BASE_URL`, `TENDERS_ROOT` and `ANTHROPIC_API_KEY` set (extraction needs a real key; versions and parsing do not).

## Historical results and workbook verification

Seed (idempotent) the historical tender results from a checkout of `Ergplan/RE-tender-results`: `python -m fdre_platform.cli seed-awards --path <checkout> --commit <short sha>`. Records whose archived source is not on an admissible procurer host are refused and counted; nothing is converted between units. Re-run after pulling the dataset; existing rows are skipped by their stable key.

Workbook exports (`POST /api/v1/orgs/{org}/runs/{run}/workbook`) are verified by recalculating the file with LibreOffice (`soffice` must be in `PATH` on the API host; package `libreoffice-calc`). Without it the artifact is still produced and labelled `verification: unavailable`.

## Assistant and RealTalk voice

`OPENAI_API_KEY` (server only) switches the assistant from the recorded fake to the provider; `OPENAI_CHAT_MODEL` and `OPENAI_REALTIME_MODEL` name the models, `ASSISTANT_PROVIDER=recorded` forces the fake. Every message stores its provider, so a deployment without a key is visible in the data (`provider = recorded`). Voice sessions hand the browser a short-lived provider secret minted by the API; the key itself is never sent. The API refuses any event carrying audio (422) and stores captions and tool calls only; proposals expire after `ASSISTANT_ACTION_TTL_MINUTES`, voice grants after `VOICE_SESSION_TTL_MINUTES`. Tools are listed at `GET /api/v1/orgs/{org}/assistant/tools`; adding one means adding a function in `fdre_platform/assistant/tools.py` with its permission; there is deliberately no delete, SQL or shell tool.

## Post-award DPR

Awards are recorded by an approver from a succeeded, non-stale run and are frozen (database trigger). DPR versions are immutable; PDF export needs LibreOffice (`soffice`) like the workbook verification, DOCX does not.

## Checks

- `make test-platform`: 19 tests against `TEST_DATABASE_URL`; the session fixture runs `alembic downgrade base`, `upgrade head` and `alembic check`, so a model change without a migration fails here.
- `make test-engine`: the pre-existing engine and legacy API tests (about 7 minutes).
- `make check-integrations`: database and migration head, tender_engine reachability (or fixture mode), presence of `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, LibreOffice for workbook recalculation, the MILP solver.
- `tools/restart_dev.sh`: stop and restart the API and worker as background processes (development).
- `tools/demo_day1.sh`, `demo_day2.sh`, `demo_day4.sh`: the daily demonstrations against a running API and worker.
- `tools/benchmark_milp.py [seconds]`: the declared MILP benchmark; writes `docs/platform/benchmark-milp.json`.
- `tools/ui_smoke_day1.py`: Playwright smoke of sign-in, tender and scenario creation, save and sign-out (`CHROMIUM_PATH` optional).

## Data and immutability

- Records: PostgreSQL. Files: `DATA_DIR/<org>/<namespace>/<sha256-prefix>/<sha256>-<name>` (content-addressed; the key carries the organisation and reads are refused across organisations).
- Database triggers refuse any UPDATE or DELETE on `audit_event`, `scenario_input_version` and `run_artifact`, any DELETE on `run`, any change to a run's snapshot, and any change other than `stale`, `stale_reason`, `supersedes_run_id` on a run in a terminal state. Application credentials therefore cannot rewrite history even if the code tried.
- Backups: `pg_dump fdre` plus a copy of `DATA_DIR`; restore order is database first, then files (artifact rows reference file keys). The rehearsed procedure is a Day 7 deliverable.

## Logs and request tracing

Every API response carries `X-Request-Id` (taken from the request header when present). The same id is stored on every audit event the request wrote, so a user report can be traced to its mutations.

## Staging deployment (Day 7 package, `deploy/`)

| File | Purpose |
|---|---|
| `deploy/Dockerfile` | one image for API and worker: node build of the workspace, Python 3.12, LibreOffice (headless calc and writer) for workbook verification and PDF export, HiGHS wheel |
| `deploy/docker-compose.staging.yml` | `db` (PostgreSQL 16), `api` (serves `/api/v1` and the built workspace), `worker` (replicas via `WORKER_REPLICAS`), `backup` (daily `backup.sh` into a volume), `caddy` (TLS, reverse proxy) |
| `deploy/Caddyfile`, `deploy/.env.staging.example` | TLS site address and the secrets file template (`deploy/.env.staging` is gitignored) |
| `deploy/backup.sh`, `deploy/restore.sh` | consistent backup (custom-format `pg_dump` + object-store tar + sha256 sums + manifest) and a checksum-verified restore into an empty database |

```sh
cp deploy/.env.staging.example deploy/.env.staging   # fill in POSTGRES_PASSWORD, SITE_ADDRESS, keys
docker compose -f deploy/docker-compose.staging.yml --env-file deploy/.env.staging up -d --build
docker compose -f deploy/docker-compose.staging.yml run --rm api python -m fdre_platform.cli migrate
docker compose -f deploy/docker-compose.staging.yml run --rm api python -m fdre_platform.cli bootstrap --org-slug ergplan --org-name Ergplan --admin-email you@org --admin-name Admin --password '...'
docker compose -f deploy/docker-compose.staging.yml run --rm api python -m fdre_platform.cli seed-awards --path /path/to/RE-tender-results --commit <sha>
```

The build container had no Docker daemon, so the image build and the compose bring-up are untested there; the same code runs as plain processes (`make api`, `make worker`) and that is what every test and demonstration in `docs/platform/` used.

## Upgrades and migrations

Migrations are reversible Alembic revisions (`migrations/versions/0001`..`0005`); the test suite downgrades to base and upgrades to head on every run, then runs `alembic check`. Upgrade procedure: back up (`deploy/backup.sh`), pull the image, `python -m fdre_platform.cli migrate`, restart `api` and `worker`. Rollback: `alembic downgrade <rev>` then the previous image; data written by the newer tables is lost on downgrade, which is why the backup comes first. Workers finish or lose their lease on restart; a reclaimed job records "lease expired; reclaimed" on the job row.

## Backup and restore

`deploy/backup.sh <dir>` writes `fdre-<UTC stamp>/db.dump`, `objectstore.tar.gz`, `SHA256SUMS`, `MANIFEST`. `deploy/restore.sh <backup-dir> <postgresql://...> <data-dir>` verifies the checksums, refuses a non-empty target database, restores with `pg_restore --exit-on-error` and unpacks the object store. The round trip was exercised on 2026-10-15 against the development database (32 tables, row counts equal, 7 immutability triggers present after restore; a second restore into the same database refused). Restore drills belong in the staging calendar; the `backup` service runs daily.

## Monitoring and incident notes

- `GET /api/v1/health` reports database and tender_engine configuration; the compose healthcheck uses it.
- Every response carries `X-Request-Id`; audit events store it, so a user report can be joined to the audit trail (`GET /orgs/{org}/audit?...`) and to the API log.
- Stuck runs: `GET /orgs/{org}/jobs/{id}` shows attempts, lease and last error; cancel through `POST /runs/{id}/cancel`. A job past `max_attempts` stays `failed` with its error.
- Stale results after an amendment are expected and visible (`stale`, `stale_reason`); the rerun supersedes the old run and both remain readable.
- Assistant: `provider` on each message says whether answers came from the provider or the recorded fake; proposals that were never confirmed expire and are listed with status `expired`.
- Disk: the object store grows with documents, workbooks and DPR exports; artifacts are content-addressed and never rewritten.

