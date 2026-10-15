# FDRE enterprise platform. Plain processes in development; see docs/platform/OPERATIONS.md.
PY ?= .venv/bin/python
export DATABASE_URL ?= postgresql+psycopg://fdre:fdre@127.0.0.1:5432/fdre
export TEST_DATABASE_URL ?= postgresql+psycopg://fdre:fdre@127.0.0.1:5432/fdre_test

.PHONY: venv migrate bootstrap api worker web test test-platform test-engine check-integrations

venv: ## Python 3.12 environment with every dependency
	uv venv --python 3.12 .venv && uv pip install -r requirements.txt -r requirements-platform.txt

migrate: ## apply migrations to DATABASE_URL
	$(PY) -m alembic upgrade head

bootstrap: ## first organisation and administrator: make bootstrap EMAIL=... PASSWORD=...
	$(PY) -m fdre_platform.cli bootstrap --org-slug $(or $(ORG),ergplan) --org-name "$(or $(ORG_NAME),Ergplan)" --admin-email $(EMAIL) --admin-name "$(or $(NAME),Administrator)" --password $(PASSWORD)

api: ## the platform API with the workspace API mounted, on :8000
	$(PY) -m uvicorn fdre_platform.api.app:app --host 127.0.0.1 --port 8000

worker: ## the background worker
	$(PY) -m fdre_platform.worker

web: ## the React workspace on :5173 (proxies /api to :8000)
	cd react_demo && npm run dev

test-platform: ## platform tests against TEST_DATABASE_URL (migrations round-trip included)
	$(PY) -m pytest tests/platform -q -p no:cacheprovider

test-engine: ## the engine and legacy API tests (slow: full dispatch runs)
	$(PY) -m pytest tests -q -p no:cacheprovider --ignore=tests/platform

test: test-platform test-engine

check-integrations: ## database, tender_engine, model keys, spreadsheet engine
	$(PY) -m fdre_platform.cli check-integrations
