# Day 7 report: end-to-end validation and release package

Date: 2026-10-15. Branch `claude/laughing-pascal-7akw12` in `Ergplan/FDRE`. Limitations: `docs/platform/KNOWN-LIMITATIONS.md`. Operations: `docs/platform/OPERATIONS.md`.

## Gate

| Gate requirement | Evidence |
|---|---|
| All three workflows end to end, including an amendment after a completed run and the review/rerun that follows | `tests/platform/test_release_e2e.py::test_three_workflows_end_to_end_with_an_amendment_after_completed_runs` (API + worker, fixture-backed tender_engine): base RfS → requirement version 1 → review → approval; workflow B (fixed tariff, MILP) and workflow A (bid tariff search) succeed; Amendment-01 arrives → version 2 draft with a field diff, both runs flagged stale with the amendment named, impact lists both runs, tasks and notifications created, version 1 preserved as approved; a stale run cannot be awarded; version 2 reviewed and approved → auto-applied to the scenario (new revision) → rerun supersedes the stale run on a different inputs hash while the old run stays readable with its result; workflow C: award from the fresh run carries requirement version 2, the DPR traces every value to that run (`all_match`), obligations are populated. The same sequence ran against the live stack with the bundled 264-page NHPC RfS (`tools/demo_day7.sh`, output below). |
| Isolation | `test_every_organisation_route_is_invisible_to_another_organisation`: every organisation-scoped path in the OpenAPI schema (all methods) answers 404 to another organisation's administrator and 401 without a session; the other organisation sees an empty tender list. The sweep found one route that answered a non-member: `GET /orgs/{org}/requirement-catalog` (shared reference data, but served under an organisation path without a membership check); it now requires membership like every other organisation route. |
| Recovery | `test_worker_death_mid_job_and_process_restart_are_recovered`: a worker claims a job and dies; while its lease holds nobody else can take the job; after the lease expires a second worker reclaims it (attempt 2, "lease expired; reclaimed" recorded) and the run succeeds; a fresh API process against the same database serves the same run, scenario and session. Backup/restore round trip (below). |
| Performance | `test_read_endpoints_answer_within_budget` (p95 under 750 ms on the read endpoints inside the test client) and the live sample `docs/platform/perf-day7.json`: medians 3 ms (health), 8 ms (tenders), 21 ms (scenarios), 86 ms (runs with results), 15 ms (historical comparables), 81 ms (knowledge context), 48 ms (one run with its result); p95 under 110 ms everywhere. MILP benchmark unchanged from Day 4 (`docs/platform/benchmark-milp.json`: 8,760-hour solar+wind+BESS case optimal in 3.1 s; with a committed biomass unit 20.9 s). |
| Usability | Playwright smokes for Days 1, 2, 3 and 6 pass against the built workspace (`tools/ui_smoke_day*.py`); every new screen is reachable from the sidebar and every action is driven by `/api/v1` calls (the only `fetch` lives in `react_demo/src/platform/api.js`). |
| Deployment package, migrations, backup/restore, operations docs, known limitations | `deploy/Dockerfile`, `deploy/docker-compose.staging.yml`, `deploy/Caddyfile`, `deploy/.env.staging.example`, `deploy/backup.sh`, `deploy/restore.sh`; five reversible Alembic revisions round-tripped on every test run; `OPERATIONS.md` completed (deployment, upgrades and rollback, backup/restore, monitoring and incident notes); `KNOWN-LIMITATIONS.md`. |

## Backup and restore round trip (2026-10-15, development database)

```
deploy/backup.sh -> fdre-20261015T192111Z/{db.dump 1.4 MB, objectstore.tar.gz 6.2 MB, SHA256SUMS, MANIFEST}
deploy/restore.sh into an empty database: restored 32 tables and 15 objects
scenario 12 -> 12 · run 9 -> 9 · audit_event 128 -> 128 · historical_award 583 -> 583 · assistant_message 24 -> 24 · award 1 -> 1 · 7 immutability triggers present
second restore into the non-empty database: "target database is not empty (32 tables); refusing"
```

## Live end-to-end demonstration (`tools/demo_day7.sh`, abridged)

```
tender and base RfS (bundled NHPC RfS) -> requirement version 1 (local extractor labelled), accepted, approved v1 (certifiable)
workflow B run 9ab23a80: succeeded · workflow A run d75696fe: succeeded
Amendment-01 arrives after both runs completed:
  changed sector.power.common.ppa_tenure_years: 25 -> 20 · changed sector.power.fdre.assured_availability_percent: 90.0 -> 95.0
  impact: 2 requirement(s) changed; 2 run(s) marked stale
  run 9ab23a80 succeeded stale: True - amendment Amendment-01.pdf (publication 2) changed ...
  open tasks: Review Contract (PPA) duration: 25 -> 20; Review Peak availability floor: 90.0 -> 95.0; Approve requirement version ...
approved v2; applied to scenarios: project.tender.ppa_years 20, project.tender.peak_availability_floor 0.95 (scenario revision 2)
rerun 6ada581b: succeeded, supersedes d75696fe, stale False, inputs 157c5da4b7
award 6e993585 from the fresh run: requirement version 2, 7 obligations frozen
DPR trace: 47 values, all match True, source run 6ada581b stale False · export dpr-78c20824-v1.pdf 114943 B
timeline: task.create, document.upload, requirement.accept, amendment.auto_apply, scenario.inputs.save, requirement_version.approve, run.launch, run.finish, award.record, dpr.create, dpr.export
```

The rerun's equity IRR at 4.20 INR/kWh is negative for this demo configuration (150 MW contract, 20-year PPA after the amendment); the platform reports it, it does not hide it.

## Tests executed

- `tests/platform/test_release_e2e.py`: 4 passed (end-to-end with amendment, isolation over every route, recovery, latency budget).
- Full platform suite on 2026-10-15: `pytest tests/platform -q`: 67 passed, 1 skipped (live tender_engine test when no instance is configured) in 215 s, after the migrations round trip.
- `ruff check` and `ruff format --check` clean on `fdre_platform/` and `tests/platform/`; `npm run build` succeeds; browser smokes pass.
- Not executed here: the Docker image build and compose bring-up (no daemon), live provider calls (no keys, no route), the deployed tender_engine (unreachable). Each is listed in `KNOWN-LIMITATIONS.md` with what was used instead and how it is labelled in the product.

## Release statement

This is a tested enterprise **pilot** of the FDRE platform on the existing workspace: identity and tenancy, durable scenarios and immutable runs, tender intelligence with amendments, six supply modules with loss chains and reconciliation, MILP dispatch with independent certification, both economic workflows with a sourced financial model, a verified formula workbook, historical comparables, collaboration, an assistant with server-authorised tools and a voice path, and the post-award DPR. It is not labelled production-ready: the items above that could not be exercised in the build environment (container build, live model providers, deployed tender_engine, email delivery) need one staging pass with real credentials, and the modelling simplifications in `KNOWN-LIMITATIONS.md` need the finance reviewer's sign-off before a bid relies on them.

## Changed files this stage

`tests/platform/test_release_e2e.py`, `tools/demo_day7.sh`, `tools/perf_sample.py`, `docs/platform/perf-day7.json`, `deploy/` (Dockerfile, compose, Caddyfile, env example, backup and restore scripts), `docs/platform/OPERATIONS.md`, `docs/platform/KNOWN-LIMITATIONS.md`, `docs/platform/00-DISCOVERY-AND-STATUS.md`, `.gitignore`.
