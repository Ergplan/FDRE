# Delivery Backlog And Migration Plan

## 1. Scope And Staffing Assumption

Suggested workstreams: one product/domain lead, one energy/optimization modeller,
one finance modeller, one UX designer, two frontend engineers, two backend/platform
engineers and QA support. Roles may be combined; estimates must be replanned if
the available team is smaller. This is a sequencing proposal, not a delivery promise.

Use two-week planning increments with acceptance-driven exits. Preserve the
prototype while the enterprise vertical slices are validated. Do not redesign
every screen before building a functioning project/document/review/run path.

## 2. Prioritized Backlog

| Epic / priority | Owner | Scope and concrete deliverable | Dependencies | Done when |
|---|---|---|---|---|
| ENT-01 / P0 | Platform | Portable development setup, pinned environment, CI, fixture manifest | None | Second developer can build/run tests without local-user paths |
| ENT-02 / P0 | UX + frontend | Design tokens, routed shell, project context and reusable forms/tables | None | UI-01/02 prototypes, keyboard flow and responsive shell approved |
| ENT-03 / P0 | Backend | Organizations, auth, project versions, permissions and migrations | ENT-01 | Tenant and concurrent-edit tests pass |
| ENT-04 / P0 | Backend | Document/object storage, durable extraction jobs, progress/retry | ENT-03 | UI-03 uploads both CfD fixtures with page coverage and timeout handling |
| ENT-05 / P0 | Backend + frontend | Server reviewer decisions and immutable evidence | ENT-04 | UI-04 approvals survive browser/device changes; no client identity trust |
| ENT-06 / P0 | Modeller + backend | Typed rule schema, unit/calendar validation, capability compiler | ENT-03 | Unknown/unsupported rules block server-side and return useful gaps |
| ENT-07 / P0 | Modeller | Legacy NHPC adapter, explicit legacy objective and input snapshots | ENT-06 | Approved prototype golden cases reproduced within tolerances |
| ENT-08 / P0 | Backend + frontend | Background runs, job tray, immutable results and artifact APIs | ENT-07 | Cancel/retry/reconnect tests pass; one result per logical job |
| ENT-09 / P1 | EYA + frontend | Solar/wind/BESS input screens and normalized profile contracts | ENT-02/03 | UI-08/09/10 profile quality and loss-basis tests pass |
| ENT-10 / P0 | Finance + frontend | Single financial baseline, statements and fixed-sizing scenarios | ENT-07/08 | FIN-01 through FIN-14 and UI-11/18/19 pass |
| ENT-11 / P1 | Frontend + modeller | Bounds, custom dispatch, cockpit, compliance and validation views | ENT-08/09 | UI-13 through UI-20 consume versioned results and explain near-misses |
| ENT-12 / P1 | Backend + UX | Amendment operations, conflict resolution and independent approval | ENT-05/06 | UI-05/06 creates new versions without rewriting history |
| ENT-13 / P1 | Reporting + QA | Detailed custom/optimized EYA, reports, exports and lineage | ENT-08/10/11 | UI-21 exports reconcile to pinned run and template version |
| ENT-14 / P0 for E2 | Modeller + finance | CfD interval scheduling, weekly ledger, market-price settlement and amendment adapter | ENT-06/12 | RUL/CFD fixtures independently approved; no default PPA pricing |
| ENT-15 / P1 for E2 | Frontend + backend | Market scenario ingestion and CfD-specific presentation | ENT-14 | UI-12 and CfD variants of compliance/financials pass |
| ENT-16 / P1 | Optimization modeller | Pure bid-price objective, documented secondary objective, search bounds/gap evidence | ENT-07/14 | Small enumerated cases and full-term challenger tests pass |
| ENT-17 / P0 release | QA + platform | Performance, access, backup/restore and release evidence | All release epics | Signed release acceptance and rollback drill |
| ENT-18 / P2 | Domain team | RTC, energy-only, scheduled-profile and storage-service adapters | Stable E1/E2 contracts | Separate source and golden-fixture suite for each family |

P0 does not mean all work is serial. UX and fixture preparation can proceed in
parallel with persistence. Do not postpone server approval and lineage until after
models are exposed to multiple enterprise users.

## 3. Suggested Milestones

| Milestone | Indicative increments | Reviewable outcome |
|---|---|---|
| M0: mobilize | 1 | Development setup, code inventory, domain fixture ownership, wireframe shell |
| M1: reviewable tender | 2-3 | Project library, durable upload/extraction, source viewer, reviewer queue |
| M2: reproducible FDRE run | 4-5 | Approved rules, legacy adapter, versioned profiles and background optimization |
| M3: enterprise FDRE pilot | 6-7 | Finance/scenarios, validation, detailed reports, access/recovery evidence |
| M4: CfD pilot | 8-10 | Reviewed CfD adapter, market scenarios, amendment settlement and full acceptance |
| M5: additional families | Re-estimate after pilot | One adapter and evidence package at a time |

Parallelize discovery of CfD rules from increment 1; production release still
depends on persistence, review, temporal accounting and independent validation.
Estimate actual solve time and memory before committing to full-life MILP SLAs.

## 4. First Sprint Tickets

| Ticket | Deliverable | Acceptance |
|---|---|---|
| ENT-01.1 | Clone/bootstrap guide and environment manifest | Backend, React and selected tests run from a fresh checkout |
| ENT-01.2 | Fixture asset registry | NHPC/CfD references have hashes, ownership and access instructions |
| ENT-02.1 | Shell and UI-01/03/04 wireframes | Project context, jobs, evidence drawer and mobile state review |
| ENT-03.1 | Database migrations for organizations/projects/versions | Cross-tenant and optimistic-concurrency tests |
| ENT-03.2 | Identity/permissions adapter | API derives actor; unauthenticated writes rejected |
| ENT-04.1 | Upload and document-version endpoints | Checksum/MIME validation and duplicate-version behavior |
| ENT-06.1 | Rule types and compatibility response draft | Modeller reviews unit/period/denominator contracts |
| ENT-07.1 | Legacy result snapshot fixtures | Baseline score components and assumptions recorded |
| ENT-10.1 | Zero-debt and sculpted-debt golden models | Finance owner approves expected cash-flow schedules |

Sprint exit: demonstrate upload -> extraction status -> field review -> persisted
draft. No claim that the new bid optimizer is production-ready at that milestone.

## 5. Migration Sequence

1. Snapshot current behavior and tests; record known deficiencies separately from
   parity expectations. Preserve source data and sample report artifacts.
2. Introduce IDs, immutable input snapshots and `/api/v1` alongside legacy routes.
3. Wrap the existing engine in `legacy_nhpc`; do not rename/move core modules until
   the compatibility wrapper passes regression tests.
4. Move browser-local reviews through an explicit import wizard. Imported names
   are historical annotations, not authenticated approvals; re-approval is required.
5. Move one React feature at a time into typed modules and project routes. Compare
   against Streamlit using the feature-parity checklist below.
6. Add versioned resource/financial inputs and job execution before enabling long
   multi-user optimization. Keep a reproducible legacy run option for comparison.
7. Implement and validate CfD as a separate adapter. Never reinterpret existing
   PPA result rows as market-settlement rows.
8. Switch the enterprise workspace default after E1 acceptance. Retain legacy
   read-only access and migration backups for the agreed transition period.

Rollback returns the UI/API to a compatible release while keeping immutable
records/artifacts. Database migrations use expand/backfill/contract; postpone
destructive changes until the rollback window is closed.

## 6. Feature-Parity Register

Maintain an owner, old screen, new screen, fixture, status and evidence link for:

- Tender parsing/review, dates, fees, eligibility, amendments and clause evidence.
- Fixed contracted capacity, technology toggles, search bounds, peak windows and
  forced two-hour BESS mode; distinguish custom and optimized asset sizes.
- Up to three PVsyst sites, selectable P-level and per-site sizing outputs.
- Wind CSV normalization, turbine assumptions, loss/uncertainty and scenarios.
- BESS DoD/RTE/SoH/availability and augmentation by year/cohort.
- Technology-specific capex, development/transmission costs, opex, debt, cost of
  equity, working capital and finance explanation.
- Optimization, custom dispatch, full-size dispatch cockpit and SOC diagnostics.
- Annual/period compliance matrices, full-contract exports and near-miss validation.
- Financial statements and fixed-sizing sensitivity baseline reset behavior.
- Detailed Joulewise custom/optimized reports, all annexures, charts and narratives.

Each row is accepted, intentionally replaced with approved rationale, or deferred
with a release label. A visually polished screen is not evidence of functional parity.

## 7. Decisions And Risks

| ID | Decision/risk | Proposed starting position | Owner / decision point |
|---|---|---|---|
| ADR-01 | Deployment and tenant boundary | Shared service with strict organization/project authorization; assess dedicated deployments separately | Platform, M0 |
| ADR-02 | Production approvals | Reviewer/editor and approver separated; documented admin exception | Product/commercial, M1 |
| ADR-03 | Queue/runtime | Durable worker execution with cancellation, leases and retries | Platform, M1 |
| ADR-04 | Time basis | Explicit interval calendar; preserve legacy 8760/8766 distinction only inside legacy adapter | Modeller, M2 |
| ADR-05 | Objective | Minimum required bid price with explicit secondary criteria; retain legacy weighted score for comparison | Bid lead/modeller, M2 |
| ADR-06 | CfD uncertainty | Scenario forecasts and market clearing assumptions supplied by business; no default perfect foresight | Commercial, before M4 |
| ADR-07 | Market/REC data licensing | Authorized dataset ingestion and redistributable test fixtures | Product, before M4 |
| ADR-08 | Financial truth source | Independently reviewed model/workbook; define tax and debt assumptions | Finance, M0-M2 |
| ADR-09 | Reporting fidelity | Reference-template section checklist and versioned renderers | Product/reporting, M3 |
| ADR-10 | External modelling scope | MCP, flow, wake and terrain studies can be imported; do not imply in-house CFD implementation | EYA lead, M2 |
| ADR-11 | UI language/branding | English and INR first; unit-ready labels and configurable organization branding | UX/product, M0 |
| ADR-12 | Optimality language | Certificate only for supported formulation; evidence grade otherwise | Modeller/QA, M2 |

Unknown source clauses and market assumptions are tracked as issues with an owner;
they are not silently filled using the NHPC template. An unresolved critical rule
blocks the affected family, not unrelated working projects.

## 8. Review And Release Checklist

- Product signs off primary journeys and all deferred parity items.
- Domain leads approve consolidated tender rules and independent golden outputs.
- Backend proves tenant isolation, persistence and concurrent-review handling.
- QA demonstrates model-input round trips, zero debt, SOC accounting, source
  fallback, amendment versioning, scenario isolation and full-term exports.
- UX verifies responsive layouts, keyboard flow, readable units and error states.
- Operations restores a backup and demonstrates worker crash/cancel recovery.
- Release notes name enabled adapters, unsupported clauses and benchmark limits.

## 9. Repository Working Agreement

Use small reviewed branches by epic. Keep schema/API changes and migration tests
together. No live credentials, local environments, client-browser storage dumps or
unlicensed datasets in Git. Store approved synthetic/redistributable fixtures in
the test tree and private source fixtures in authorized object storage.

CI should run schema validation, backend unit/contract tests, numerical small
fixtures, frontend type/build checks and browser smoke tests on each PR. Run the
longer full-term optimizer matrix on scheduled/release builds with pinned inputs.
No numerical test may be updated simply to bless an unexplained result change.
