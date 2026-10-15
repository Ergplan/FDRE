# Enterprise pilot: discovery, gap inventory and seven-day checklist

Written 2026-10-15 at the start of the seven-day build. Kept current: the status column
and the day checklists are updated at the end of every day, in the same commit as the code.

## 1. What exists (verified by reading the code, not the documentation)

| Area | Where | Actual state |
|---|---|---|
| Application entry point | `react_demo/src/main.jsx` (React 19 + Vite + ECharts, one 3,454-line file, 13 tabs) served by `react_demo/backend/api.py` (FastAPI, synchronous `/api/*` routes) | Working FDRE (firm and dispatchable, NHPC Tranche-II style) workspace: tender upload, project configuration, yield, finance, statements, sensitivity, custom dispatch, optimisation, optimiser validation, EYA, results, reports, exports. This is the "existing round-the-clock/BESS tender workspace" and is preserved as the scenario workspace of the platform. |
| Engine | `fdre_enterprise_engine.py` (2,200 lines) | Hourly chronological dispatch (greedy priority rules, not an optimiser), monthly peak availability and annual CUF tests, capex/IDC/debt/tax/DSCR financial model, required-tariff bisection, capacity search. |
| Capacity optimiser | `optimize_capacity`, `_capacity_seed_highs` | **Verified: a HiGHS LP seed (linearised annual energy and peak power, proxy capex) followed by a candidate grid, random samples and greedy coordinate descent, each candidate scored through dispatch + finance.** It is a screening search, not a MILP and not a certified optimum. It is not renamed. The MILP formulation is new work (Day 4). |
| Finance | `financial_model`, `required_tariff`, `irr`, `npv` | Annual (not monthly) cash flows, annuity or sculpted debt, WDV tax depreciation, loss carry-forward, working capital, year-11 augmentation. IRR is a single root finder; multiple roots are only warned about in MODEL_NOTES. |
| Tender text | `fdre_tender_rag.py`, `fdre_tender_review.py`, `react_demo/src/TenderReview.jsx` | Lexical heuristics, review decisions stored in `localStorage`, no server record, reviewer identity is typed text. Replaced by the tender_engine integration. |
| Tests | `tests/` (8 files) | 50 pass, 5 skipped (skips need files under a developer's home directory). Run takes 7 minutes because the optimiser tests run the full engine. |
| Persistence, auth, tenancy, jobs, audit | none | **Missing.** Everything is in-request and in-browser. |
| Design system | `Ergplan/charting` (`design-system/`, ergOS Harmony tokens, `eg-` CSS kit, chart library) | Available as reference; the workspace keeps its own `styles.css`. Harmony tokens are adopted only where new screens are built. |
| Isometric primitives | `Ergplan/Replanner` `apps/web/lib/iso.ts` (88 lines: `iso`, `box`, `tile`, `panelGrid`, `route`) and `docs/isometric-design-system.md` | Reusable 2:1 projection and primitives; copied with origin noted when the supply modules are built (Day 3). Replanner's `energy_core/optimization/model.py` (Pyomo + HiGHS, 35,040 blocks, capacity + dispatch) and `validation/certify.py` (independent block-by-block recomputation) are the pattern for the Day 4 MILP and validator. |
| Historical results | `Ergplan/RE-tender-results` `tender-results-viewer/public/data.json` (623 records, 122 archived sources with sha256, snapshot 7 Oct 2026) | Schema and provenance verified (`docs/reports/RE-TENDER-RESULTS-ASSESSMENT.md` in tender_engine describes it accurately). Units are mixed (INR/kWh 491, INR/MW VGF, INR/kg...); status has 12 values; `id` is positional and not stable. Seeded on Day 5 with a stable key (source sha256, page, bidder, allocation). |
| Tender parser and amendment tracker | `Ergplan/tender_engine` (FastAPI + Postgres + worker; `/api/v1/tenders`, `/tenders/{id}/versions` (multipart upload creates a corrigendum/amendment/clarification version), `/tenders/{id}/review-state`, `/tenders/{id}/view` (current projection with the version that last changed each field), `/tenders/{id}/amendments` (per-version added/changed/restated diff), `/tenders/{id}/summarize`, `/approvals`, `/review-tokens`) | Real code inspected (`api/v1/tenders/tenders.py`, `tender/services/amendments.py`, `core/models/truth.py`). Extraction needs `ANTHROPIC_API_KEY`; ingest and parse do not. Identity is a per-tender review token or the `X-Reviewer` header inside the deployment; there is no user login. The deployed instance (`https://34.131.65.108`) is not reachable from this build container. |

## 2. Integration and credential checks (Day 1)

| Dependency | Check | Result |
|---|---|---|
| PostgreSQL | local cluster 16.15 | Running; databases `fdre`, `fdre_test`, role `fdre`. |
| Docker | daemon | **Not available in the build container** (no socket, no systemd). Compose files are written and documented but could not be executed here; the stack is run as plain processes. |
| tender_engine deployed API | `https://34.131.65.108/health` | **Unreachable from the build container** (no route). Adapter is built against the inspected routes and tested against (a) a fixture-backed fake with recorded response shapes and (b) a local tender_engine process when its dependencies are installed. Fixture-backed behaviour is labelled in the UI and the API (`source: "fixture"`). |
| `ANTHROPIC_API_KEY` | environment | **Absent.** tender_engine extraction cannot run here; parsing and versioning can. |
| `OPENAI_API_KEY` | environment; `api.openai.com` | **Absent**, and the host is not reachable through this container's proxy. The assistant and RealTalk voice (Day 6) are built against the documented API with a recorded-response fake; the live check is a documented operator step. |
| Spreadsheet recalculation engine | LibreOffice 24 (`soffice`) present; `formulas` Python package to be installed | LibreOffice headless recalculation is the planned verifier for the Day 5 workbook. |
| MILP solver | `highspy` 1.11 and `pulp` installed in `.venv` | Available. |

## 3. Implemented / partial / missing inventory against the product outcome

| Capability | Status at start | Owner day |
|---|---|---|
| Organisations, users, memberships, roles, permissions | missing | 1 |
| Durable scenarios, input versions, revision checks, conflicts | missing | 1 |
| Runs as immutable snapshots, durable jobs, worker | missing (in-request only) | 1 (infrastructure), 4 (solver jobs) |
| Audit events with actor, before/after, version, request id | missing | 1 |
| Tender records, documents, amendment chain, source references | partial in tender_engine (not linked to scenarios) | 2 |
| Evidence-linked summary and requirement review | partial (tender_engine, review-token identity) | 2 |
| Executable rule-set versions separated from extraction | missing | 2 |
| Amendment impact: diff, draft requirement version, stale flags, notifications, tasks | diff exists in tender_engine; impact mapping, staleness, notifications missing | 2 |
| Six supply modules with isometric diagrams and loss chains | solar/wind/BESS inputs exist (no thermal, biomass, IEX; no loss chain reconciliation; no diagrams) | 3 |
| Profile validation (timezone, interval, leap year, duplicates) | missing (synthetic profiles, one CSV path) | 3 |
| MILP dispatch with commitment, SOC continuity, obligations | done Day 4 (`fdre_platform/optimization`) | 4 |
| Tariff search over fixed-tariff MILP with validated monotonicity | partial (bisection over greedy dispatch + finance) | 4 |
| Fixed-tariff investment evaluation (workflow B) | partial (`/api/evaluate` with fixed sizing) | 4 |
| Independent physical and financial validation | partial (`/api/optimizer/validate` compares to itself) | 4 |
| Formula-based Excel model with verified recalculation | missing (static xlsx in `Enterprise_Build/`) | 5 |
| Historical comparable tenders with units and sources | dataset exists; no ingestion, no comparison | 5 |
| Chat, threaded comments, mentions, tasks, notifications | missing | 5 |
| Assistant with server-authorised tool registry; RealTalk voice | missing (built Day 6; live provider path untested here, recorded model labelled) | 6 |
| Post-award DPR with frozen baseline, versions, exports | missing (built Day 6) | 6 |
| Regression, isolation, recovery, performance tests; deployment docs | partial (engine tests only) | 7 |

## 4. Architecture decisions for the pilot

1. **The platform lives in this repository** (`fdre_platform/` Python package, Alembic migrations, `react_demo/src/platform/` UI). tender_engine stays a separate service used over its HTTP API through `fdre_platform/integrations/tender_engine.py`; its code is not imported at runtime and its repository is not modified by this build (its own operating rules govern changes there).
2. **Stack unchanged**: Python 3.12, FastAPI, SQLAlchemy 2, Alembic, Pydantic 2, pytest; React 19 + Vite + ECharts in JSX. No TypeScript migration, no framework change.
3. **Storage**: PostgreSQL for all records; files under a content-addressed local object store (`fdre_platform/storage.py`) with the same interface for an S3/GCS backend later.
4. **Jobs**: a Postgres job table claimed with `FOR UPDATE SKIP LOCKED`, leases and bounded retries, run by `python -m fdre_platform.worker`. No Redis, no Celery.
5. **Identity**: email + password (bcrypt), server-side sessions in the database, HttpOnly cookie or bearer token. Roles: administrator, bid_manager, engineer, finance_reviewer, approver, viewer, with an explicit permission matrix in `fdre_platform/permissions.py`. Every business table carries `organization_id`; every query filters by it; tender access needs tender membership or the administrator role.
6. **Immutability enforced in the database**: triggers refuse UPDATE/DELETE on `audit_event`, on `run` rows once their status is terminal, and on `run_input_snapshot`. Migrations are reversible.
7. **Legacy routes kept**: the existing `/api/*` endpoints are mounted unchanged under the platform app so the current workspace keeps working while screens move to `/api/v1/*`.

## 5. Seven-day checklist

- [x] **Day 1 — foundation** (done 2026-10-15, `DAY-1-REPORT.md`): package layout, settings, migrations, identity, organisations, memberships, roles, tenders (platform record), scenarios with revision checks, runs + input snapshots, jobs + worker, audit events, notifications table, storage interface, legacy mount, login and workspace bar in the UI, gate tests, Day 1 report.
- [x] **Day 2 — tender engine and amendments** (done 2026-10-15, `DAY-2-REPORT.md`): adapter, tender documents and amendment chain, requirement versions, rule-set versions, impact mapping, stale flags, notifications, tasks, timeline, gate tests.
- [x] **Day 3 — supply inputs and isometric flows** (done 2026-10-15, `DAY-3-REPORT.md`): six modules, profiles with validation, loss chains with reconciliation, diagrams, gate tests.
- [x] **Day 4 — MILP and both economic workflows** (done 2026-10-15, `DAY-4-REPORT.md`, `FORMULATION.md`): formulation, tariff search, fixed-tariff evaluation, job controls, independent validation, benchmark, gate tests.
- [x] **Day 5 — financial export, history and collaboration**: formula workbook with LibreOffice recalculation check, historical awards seed and comparables, chat/comments/mentions, concurrent-edit tests. Report: `DAY-5-REPORT.md`. Full platform suite on 2026-10-15: `pytest tests/platform -q`: 58 passed, 1 skipped (live tender_engine test when no instance is configured) in 145 s.
- [x] **Day 6 — chat, voice and DPR**: tool registry, knowledge layer, assistant, RealTalk, DPR workspace, adversarial tests. Report: `DAY-6-REPORT.md`. Full platform suite on 2026-10-15: `pytest tests/platform -q`: 63 passed, 1 skipped (live tender_engine test when no instance is configured) in 164 s.
- [x] **Day 7 — validation and release**: regression, isolation, recovery, performance, deployment package, operations docs, known limitations. Report: `DAY-7-REPORT.md`; limitations: `KNOWN-LIMITATIONS.md`. Full platform suite on 2026-10-15: `pytest tests/platform -q`: 67 passed, 1 skipped (live tender_engine test when no instance is configured) in 215 s, after the migrations round trip.
