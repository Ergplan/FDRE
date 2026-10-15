# Day 1 report: foundation and workspace

Date: 2026-10-15. Branch `claude/laughing-pascal-7akw12` in `Ergplan/FDRE`.

## Gate

| Gate requirement | Evidence |
|---|---|
| Two users can work in the same authorised tender | `tests/platform/test_identity_and_tenancy.py::test_two_users_share_an_authorised_tender`; `tools/demo_day1.sh` (engineer gets 404 before membership, 200 after; bid manager and admin save successive versions of one scenario) |
| Another tenant cannot access its data | `test_another_tenant_cannot_reach_the_data`: every route answers 404 for a member of another organisation, through either organisation's URL, with no existence leak; notifications and audit scoped likewise |
| A saved scenario survives restart | `test_saved_scenario_survives_an_application_restart` (a second application instance with its own pool reads the version back); the demo database persists under the local PostgreSQL cluster |
| Mutations have attributable audit records | `test_every_mutation_has_an_attributable_audit_record`: actor user id and email, action, object type/id, object version, before/after, request id; `test_audit_log_is_append_only_in_the_database` |

## What was built (changed files)

- `fdre_platform/` new package: `config.py`, `db.py`, `permissions.py` (6 roles, 16 permissions, explicit matrix), `storage.py` (content-addressed local object store behind one interface), `models/` (organisation, user, membership, user_session, tender, tender_member, scenario, scenario_input_version, run, run_artifact, job, notification, audit_event), `services/` (auth, audit, tenders, scenarios, runs, jobs, notifications, context), `api/` (app factory, deps, error mapping, routes for auth, organisations, tenders, scenarios, runs, jobs, notifications, health), `worker/` (poller with leases, heartbeat, retries, cancellation; the `run` handler executes evaluate and legacy capacity-search runs with the existing engine), `cli.py` (bootstrap, add-user, migrate, check-integrations).
- `migrations/` Alembic with `0001_foundation` including database triggers that make audit events, input versions and run artifacts append-only and completed runs immutable; `alembic downgrade base` is exercised by the test session.
- `react_demo/src/platform/`: `api.js` (the only place `/api/v1` is called), `Login.jsx`, `WorkspaceBar.jsx` (organisation, tender, scenario context; load/save with the loaded revision; conflict banner with "reload theirs" or "save mine on top"; queue evaluate runs; run tray with stale marking). `main.jsx` gained the sign-in gate and the bar; the thirteen existing tabs are untouched.
- `tests/platform/` 19 tests; `Makefile`, `ruff.toml`, `requirements-platform.txt`, `.env.example`, `alembic.ini`; `docs/platform/00-DISCOVERY-AND-STATUS.md`, `OPERATIONS.md`, this report; `tools/demo_day1.sh`, `tools/ui_smoke_day1.py`, screenshots in `docs/platform/day1-artifacts/`.

## Tests executed and results

| Suite | Command | Result |
|---|---|---|
| Platform | `make test-platform` | 19 passed in 42 s (includes migration downgrade/upgrade/check) |
| Engine and legacy API (pre-existing) | `.venv/bin/python -m pytest tests -q --ignore=tests/platform --ignore=tests/test_optimizer_bounds_matrix.py` | 50 passed, 5 skipped in 7 min 09 s (skips need files under a developer's home directory; unchanged from baseline) |
| Lint | `ruff check` / `ruff format --check` on `fdre_platform`, `tests/platform` | clean |
| Web build | `npm run build` in `react_demo` | built |
| Browser smoke | `tools/ui_smoke_day1.py` | sign in, create tender and scenario, save, sign out: ok |

## Reproducible demonstration

```sh
make migrate && make bootstrap EMAIL=admin@ergplan.test PASSWORD=demo-pass-123
.venv/bin/python -m fdre_platform.cli add-user --org-slug ergplan --email engineer@ergplan.test --name Engineer --password demo-pass-123 --role engineer
.venv/bin/python -m fdre_platform.cli add-user --org-slug ergplan --email bids@ergplan.test --name "Bid Manager" --password demo-pass-123 --role bid_manager
make api &  make worker &
tools/demo_day1.sh
```

Output of the run on 2026-10-15:

```
engineer before membership: HTTP 404
engineer after membership:  HTTP 200
admin saved revision 2
engineer: conflict - current revision 2 - conflicts ['settings.solarAcMw']
run a4021a89 succeeded tariff 6.135791746488816 runtime s 3.777 snapshot inputs hash c0fd6b1b7378
2026-10-15T16:27:12  admin@ergplan.test      scenario.inputs.save   v2  req=9dc4dcd1
2026-10-15T16:27:12  bids@ergplan.test       scenario.inputs.save   v1  req=8405e3ab
2026-10-15T16:27:12  bids@ergplan.test       scenario.create        v0  req=8405e3ab
GET /api/defaults: HTTP 200
```

## Integration and credential checks (started on Day 1 as required)

| Dependency | Status | Consequence |
|---|---|---|
| PostgreSQL 16 | available (local cluster) | all persistence tests run against the real database |
| Docker daemon | not available in the build container | compose packaging is written on Day 7 but cannot be executed here; processes run directly |
| tender_engine deployed instance | unreachable from the build container | Day 2 adapter is built against the inspected routes; fixture-backed answers are labelled `source: "fixture"`; a local tender_engine process is the fallback for a live integration test |
| `ANTHROPIC_API_KEY` | missing | tender_engine extraction cannot be exercised live; parsing and versioning can |
| `OPENAI_API_KEY`, `api.openai.com` | key missing, host not reachable through the container proxy | Day 6 assistant and RealTalk are built against recorded responses; the live check is an operator step |
| LibreOffice | available | Day 5 workbook recalculation can be verified |
| HiGHS (`highspy`), PuLP | available | Day 4 MILP |

## Defects, blockers and limitations

- Runs of kind `optimize` still execute the legacy HiGHS-LP-seed plus candidate search and are labelled `capacity_search_legacy` / "screening (not certified)"; the MILP arrives on Day 4.
- Finance inputs are recognised by path prefix (`finance.`, `settings.finance.`, `project.finance.`); the explicit input schema with units and ownership arrives with the supply modules on Day 3.
- Notifications are in-app only; the delivery fields exist and the email/webhook channel is Day 5.
- The workspace bar saves the whole settings object plus the engine project; the per-module input versions arrive on Day 3.
- The legacy workspace routes (`/api/*`) remain unauthenticated and stateless, as before; they are reachable only behind the same process and will move behind the session on Day 2 when the tender upload moves to tender_engine.
- The test and demo passwords in this report are for local use only.

## Next: Day 2 concrete work

1. `fdre_platform/integrations/tender_engine.py`: typed client for `POST /tenders`, `POST /tenders/{id}/versions` (multipart, kind, issued_on, role), `GET /tenders/{id}/versions`, `/view`, `/review-state`, `/amendments`, `/summarize`, `POST /approvals`; fixture mode with recorded response shapes from the inspected schemas.
2. Platform tables: `tender_document` (sha256 dedupe, source URL, publication order, effective date, supersedes), `requirement_version` (extracted → reviewed → approved rule set, with evidence refs, provenance kind, confidence), `rule_set_version` (executable rules, supported/unsupported), `amendment_impact` (field diff, affected inputs/constraints/runs/reports, owner).
3. Amendment arrival flow: dedupe, version, diff via tender_engine, draft requirement version, stale flags on runs and reports, notifications and review tasks, timeline.
4. Evidence-linked summary screen replacing the browser-local `TenderReview`.
5. Gate tests on a base tender and an amendment fixture.
