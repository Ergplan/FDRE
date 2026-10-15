# Day 2 report: tender engine and amendments

Date: 2026-10-15. Branch `claude/laughing-pascal-7akw12` in `Ergplan/FDRE`.

## Gate

| Gate requirement | Evidence |
|---|---|
| A base tender and an amendment produce an accurate field diff | `tests/platform/test_amendments.py::test_base_tender_then_amendment_flow`: changed (deadline, CUF band lower limit, external sourcing), restated (availability), removed (ceiling tariff) with old value, new value and page/excerpt evidence; untouched fields are not reported. `tools/demo_day2.sh` on the real NHPC RfS plus a generated Amendment-01: PPA tenure 25 → 20 and availability 90 → 95 found with page evidence. |
| Updated draft requirements | Version 2 is created as a draft that carries every unchanged row with its review state and holds the changed rows as unreviewed with the previous reading kept as an alternative. |
| Stale-result flags | Completed runs whose inputs or constraints a change touches are marked stale with the reason; their results stay immutable (`run.status` and `result` unchanged, database trigger). |
| Actionable notifications | Every tender member and administrator gets one deduplicated notification per amendment; one review task per changed requirement goes to the tender owner and one approval task to the bid manager; a second upload of the same bytes is refused (409) and creates nothing. |
| Previous baseline preserved | Version 1 stays `approved` and locked (API 422, database trigger) until version 2 is approved, when it becomes `superseded`; both are listed with their rows. |

## What was built (changed files)

- `fdre_platform/integrations/tender_engine.py`: typed adapter for the inspected tender_engine routes (tenders, versions, view, review-state, amendments, extract) with two implementations: `HttpTenderEngine` (live) and `FixtureTenderEngine` (recorded JSON under `tests/fixtures/tender_engine/`, every answer labelled `source: fixture`). Mapping of the engine's `TenderView` and `ReviewState` shapes to platform candidates, flattening record fields to dotted paths.
- `fdre_platform/rules/catalog.py`: the requirement catalogue (49 fields keyed by tender_engine's `core.*` and `sector.power.*` paths plus four `platform.*` paths) with engine input mapping, unit transforms, auto-apply flags, rule types and constraint names. `rules/compile.py`: compiles a requirement version into executable rules with the engine's capability table; unsupported rules are listed and block certification. `rules/local_extractor.py`: deterministic regex extractor over page text with page and sentence evidence, labelled `local_regex_v1`, used when tender_engine holds no extraction.
- Models and migration `0002`: `tender_document` (sha256 dedupe per tender, publication order, issued/effective dates, supersession, source URL, engine ids), `requirement_version`, `requirement` (value, unit, effective date, confidence, provenance extracted/inferred/defaulted/user_entered, evidence, alternatives, review state, original value on correction, change kind, supersedes), `rule_set_version`, `amendment_impact`, `review_task`; `audit_event.tender_id`; triggers locking approved versions' rows and refusing deletes of documents and impacts.
- Services: `documents.py` (store, dedupe, chain, push to engine, candidate extraction), `requirements.py` (diff, draft versions, review with evidence requirement for corrections, approval and rule compilation, discard), `amendments.py` (ingest flow, impact with affected inputs/constraints/runs/reports/owner, stale flags, notifications, tasks, auto-apply on approval, timeline), `summary.py` (evidence-linked summary with missing information, contradictions and bid risks).
- Routes under `/api/v1/orgs/{org}`: document upload (multipart) and listing, file download, requirements (current, versions, manual entry, review, approve, discard), rules, summary, amendments, timeline, tasks, tender-engine health, requirement catalogue.
- UI: `react_demo/src/platform/TenderTab.jsx` (documents and chain with upload, requirement review table with accept/correct/reject and evidence chips, summary, amendment impacts with old/new/evidence/affected/owner, tasks, timeline); the Tender Upload tab now switches between it and the legacy browser-only parser.
- Permission `requirement.review` (administrator, bid manager, engineer, finance reviewer, approver).

## Tests executed and results

| Suite | Command | Result |
|---|---|---|
| Platform (Day 1 + Day 2) | `make test-platform` | 26 passed, 1 skipped (the live test without `TENDER_ENGINE_LIVE_URL`) in 69 s |
| Live tender_engine contract | `TENDER_ENGINE_LIVE_URL=http://127.0.0.1:8100 TENDER_ENGINE_ADMIN_TOKEN=adm pytest tests/platform/test_tender_engine_live.py` against a tender_engine instance started from the `Ergplan/tender_engine` checkout (its migrations 0001-0013 applied to a local database) | 1 passed: health, create tender, two version uploads, versions, view and review-state shapes, amendments |
| Lint and format | `ruff check`, `ruff format --check` | clean |
| Web build | `npm run build` | built |
| Browser smoke | `tools/ui_smoke_day2.py` | requirements, summary, documents, amendments, tasks and timeline views render for the demo tender |

## Reproducible demonstration

```sh
# tender_engine locally (from its own checkout, its own venv and database; no model key needed for versions and parsing)
DATABASE_URL=postgresql+psycopg://fdre:fdre@127.0.0.1:5432/tender_local DATA_DIR=/tmp/te-data TENANT_ID=ergplan ANTHROPIC_API_KEY=not-set \
  PUBLIC_BASE_URL=http://127.0.0.1:8100 TENDERS_ROOT=/tmp/te-tenders ADMIN_TOKEN=adm PYTHONPATH=/home/user/tender_engine \
  python -m alembic upgrade head && python -m uvicorn api.main:create_app --factory --port 8100
# platform pointed at it
TENDER_ENGINE_URL=http://127.0.0.1:8100 TENDER_ENGINE_ADMIN_TOKEN=adm make api & make worker &
tools/demo_day2.sh
```

Output on 2026-10-15 (abridged):

```
tender_engine: {"source":"live","status":"ok"}
document 1 RFS.pdf extractor: local_regex_v1 | requirement version 1 | candidates: 7
  sector.power.common.total_capacity_mw: 1200.0 (p.1)
  sector.power.common.ppa_tenure_years: 25 (p.8)
  sector.power.fdre.assured_availability_percent: 90.0 (p.61)
same bytes again: HTTP 409
approved version 1 rule set 1 rules 5 certifiable False | blocking: ['required requirement missing: core.key_dates.bid_submission_deadline', ...]
  changed   sector.power.common.ppa_tenure_years: 25 -> 20  (p.1: The PPA shall be valid for a period of 20 (twenty) years ...)
  changed   sector.power.fdre.assured_availability_percent: 90.0 -> 95.0  (p.1: ... minimum availability of 95% ...)
impact: 2 requirement(s) changed; 1 run(s) marked stale
run a83a93d2 succeeded stale: True - amendment Amendment-01.pdf (publication 2) changed sector.power.common.ppa_tenure_years, ...
engineer unread notifications: 1 | Amendment to NHPC FDRE Tranche-II (Day 2 demo): 2 requirement(s) changed
open tasks: [amendment_review] Review Contract (PPA) duration: 25 -> 20 ; [amendment_review] Review Peak availability floor: 90.0 -> 95.0 ; [requirement_version_approval] ...
approved version 2 | applied to scenarios: [{'scenario_id': 'a448d539...', 'updates': {'project.tender.ppa_years': 20, 'project.tender.peak_availability_floor': 0.95}}]
versions: [(1, 'superseded'), (2, 'approved')]
```

## Fixture-backed versus live behaviour (labelled)

- Live tender_engine: versions, document dedupe by the engine, parsing and the `view`/`review-state` contract are exercised against real code. Extraction (model calls) could not run because no `ANTHROPIC_API_KEY` is available; in that case the platform's local regex extractor produces the candidates, and every such value carries `extractor: local_regex_v1`, confidence 0.6 and its page and sentence. The local extractor read 7 of the catalogue's 49 fields from the real RfS; the rest are reported as missing, never defaulted.
- Fixture tender_engine (default when `TENDER_ENGINE_URL` is empty): the gate test uses a recorded two-version view of an NHPC-style FDRE tender; the UI shows the `tender_engine: fixture` chip and documents carry `extractor: tender_engine:fixture`.

## Defects, blockers and limitations

- The local extractor is a stop-gap with 18 regex rules; it misreads nothing silently but misses most fields (7 of 49 on the RfS). Evidence-linked extraction of the full catalogue needs tender_engine with a model key.
- Record-valued requirements (`source_mix_rules`, structured records) are flattened to scalar keys; list-valued records are kept as JSON in the row and are not diffed element by element.
- Audit events within one second are ordered by id, so the timeline can interleave events of one request; a sequence column is a small follow-up.
- Supported-rule decisions are coded for the legacy FDRE adapter (`rules/compile.py`); the Day 4 formulation will widen them (RE share, source eligibility) and the capability table must be updated with it.
- Notifications are in-app only; delivery attempts and dedupe exist, the email/webhook channel does not yet.
- The legacy browser-only parser remains reachable under the Tender Upload tab as "Local parse (legacy)"; it will be removed once the Day 3 inputs flow entirely from requirements and modules.

## Next: Day 3 concrete work

1. Supply modules: solar, wind, thermal, biomass, IEX purchase/sale, BESS as typed input schemas with units, electrical boundary and time basis, provenance and validation per field.
2. Profile ingestion: timestamp, timezone, interval, leap year, missing and duplicate intervals, normalisation; CUF tied to capacity and basis; scaling within physical bounds; content hash on every profile.
3. Loss chains: sequential multiplicative percentage losses, fixed auxiliary loads, availability; "already in profile" flags to prevent double counting; gross-to-net reconciliation table.
4. Isometric diagrams per module with the Replanner primitives, editable inputs on components, provenance and completeness indicators; links between diagram values, tables and model inputs.
5. Gate tests: every displayed loss maps to a model input, reconciliation closes, invalid profiles and duplicate losses are rejected.
