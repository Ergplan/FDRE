# Operations (Day 1 version; completed on Day 7)

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

## Checks

- `make test-platform`: 19 tests against `TEST_DATABASE_URL`; the session fixture runs `alembic downgrade base`, `upgrade head` and `alembic check`, so a model change without a migration fails here.
- `make test-engine`: the pre-existing engine and legacy API tests (about 7 minutes).
- `make check-integrations`: database and migration head, tender_engine reachability (or fixture mode), presence of `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, LibreOffice for workbook recalculation, the MILP solver.
- `tools/demo_day1.sh`: the Day 1 demonstration against a running API and worker.
- `tools/ui_smoke_day1.py`: Playwright smoke of sign-in, tender and scenario creation, save and sign-out (`CHROMIUM_PATH` optional).

## Data and immutability

- Records: PostgreSQL. Files: `DATA_DIR/<org>/<namespace>/<sha256-prefix>/<sha256>-<name>` (content-addressed; the key carries the organisation and reads are refused across organisations).
- Database triggers refuse any UPDATE or DELETE on `audit_event`, `scenario_input_version` and `run_artifact`, any DELETE on `run`, any change to a run's snapshot, and any change other than `stale`, `stale_reason`, `supersedes_run_id` on a run in a terminal state. Application credentials therefore cannot rewrite history even if the code tried.
- Backups: `pg_dump fdre` plus a copy of `DATA_DIR`; restore order is database first, then files (artifact rows reference file keys). The rehearsed procedure is a Day 7 deliverable.

## Logs and request tracing

Every API response carries `X-Request-Id` (taken from the request header when present). The same id is stored on every audit event the request wrote, so a user report can be traced to its mutations.
