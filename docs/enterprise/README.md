# FDRE Enterprise Development Handoff

Specification version: 1.0 | Prepared: 2026-09-28 | Baseline: `ff5282b`

Audience: product owner, renewable-energy modeller, finance modeller, UX designer,
frontend/backend engineers, QA and platform operations.

This is a **proposed implementation specification**, not a claim that the
enterprise features below are already implemented. It supersedes conflicting
assumptions in the earlier wireframe brief for new enterprise development.
The existing application remains the reference prototype and regression baseline.

## Read In This Order

1. [Tender families and executable rules](01-tender-rules.md)
2. [Architecture, persistence and API contracts](02-architecture-and-api.md)
3. [Enterprise navigation and screen specifications](03-ui-screen-specifications.md)
4. [Model validation and acceptance tests](04-validation-and-acceptance.md)
5. [Delivery backlog and migration plan](05-delivery-plan.md)
6. [Input ownership and unit dictionary](06-input-dictionary.md)
7. [Illustrative CfD rule-set draft](examples/cfd-review-draft.json)

Start with the release boundaries and first sprint in the delivery plan. A
designer can begin the screens while backend engineers implement immutable
project versions and a modeller defines the rule compiler interfaces.

## Product Outcome

Enable a bid team to ingest a tender and its amendments, approve an evidence-based
interpretation, configure candidate sites, evaluate resource profiles, model
financing, search for a competitive design, and issue a reproducible client report.
The same platform must support different tender families without transferring
one tender's assumptions silently into another.

The critical product distinction is:

**Document readable != field verified != rule supported != feasible design !=
financially acceptable bid != mathematically proven optimum.**

Each has a separate status in the UI, database and exported report.

## Current System Inventory

| Component | Current location | Actual capability and boundary |
|---|---|---|
| React UI | `react_demo/src/main.jsx` | Project configuration, yield, finance, optimization, dispatch, validation and reports; most screens share one large file |
| Review UI | `react_demo/src/TenderReview.jsx` | Per-field edits, approval/rejection, source pages, base-document association and JSON export; browser-local storage, no server-authoritative approval |
| Charts | React/ECharts, `styles.css` | ECharts is the established chart library; preserve it |
| API | `react_demo/backend/api.py` | Synchronous JSON endpoints; no enterprise tenant/authentication/job layer in this wrapper |
| Engine | `fdre_enterprise_engine.py` | NHPC-style hourly dispatch, monthly peak checks, annual CUF bands, financial evaluation and capacity search |
| Optimizer | `optimize_capacity`, `_capacity_seed_highs` | HiGHS LP seed followed by candidate search and dispatch/finance evaluation; not a single certified full-life optimum |
| Objective | nested `score_result` | Tariff plus capex/spillage terms; do not describe this as pure minimum tariff |
| Finance | `financial_model`, `required_tariff` | Debt schedules, debt sizing, IRR, DSCR, costs and required tariff; requires independent golden-model validation |
| EYA | `fdre_eya.py`, `fdre_wind_eya.py` | Component and hybrid yield assessment; uploaded and synthetic-profile pathways need explicit provenance |
| Extraction | `fdre_tender_rag.py` | Optional Docling, standard fallbacks, lexical retrieval and heuristic field extraction; not a complete Haystack production RAG service |
| Tender review | `fdre_tender_review.py` | Recognizes CfD documents and disables their application to FDRE inputs; no executable CfD settlement adapter |
| Legacy UI | `app.py` | Streamlit reference; retain until feature parity is signed off |
| Design references | `Enterprise_Build/`, root wireframe brief | Prior design documents and financial workbooks; reference material, not automatically validated engine contracts |

## Gaps The Team Must Address

- Some extracted values still originate from defaults or nearby-text heuristics.
  Approval must distinguish observed, inferred, defaulted and missing values.
- Existing compatibility detection is a guard, not proof that a non-CfD tender is
  supported. Unknown tender families must become review-only by default.
- Financial penalties, commercial fees and several compliance labels retain
  NHPC-specific assumptions. They must move behind versioned rule adapters.
- The API still has a contracted-capacity range fallback. The enterprise contract
  accepts one fixed bid MW and technology bounds; validate this server-side.
- Fast-mode annual values are interpolated from selected operating years.
  They cannot certify every contract year or time block.
- Browser approvals, uploaded file previews and UI settings are not durable,
  multi-user records. Review identity currently comes from typed text.
- Local filesystem paths, sample CSV dependencies and developer-specific test
  paths must be replaced with managed input assets and portable fixtures.
- Request-bound optimization and extraction need cancellable background jobs.

## Release Boundaries

| Release | Deliverable | Explicitly excluded until validated |
|---|---|---|
| E1 | Enterprise foundation, reviewer workflow and NHPC-style adapter with parity tests | Automatic support for arbitrary tender text; CfD bid pricing |
| E2 | SECI CfD adapter with amendments, time-block settlement and market scenarios | Guaranteed future market prices; global optimum claims without proof |
| E3 | Validated RTC, scheduled-profile, energy-only and storage-service adapters | Generic clause-to-code execution |

An unsupported tender can still be uploaded, reviewed and reported. Its bidding
optimizer stays disabled until every required rule has a tested implementation.

## Team Responsibilities

| Role | Owns | Required sign-off |
|---|---|---|
| Product/bid lead | User journeys, tender interpretation priorities, bid approval | Release scope and tender interpretation |
| Energy modeller | Scheduling, losses, dispatch, compliance, solver formulation | Physical invariants and tender-family fixtures |
| Finance modeller | Settlement, taxes, debt, working capital, bid economics | Independent financial reconciliation |
| UX/frontend | Design system, accessible screens, state visibility | Screen acceptance and prototype parity |
| Backend/platform | Versioning, APIs, jobs, storage, identity | Isolation, reproducibility and recovery tests |
| QA | Regression matrix, source fixtures, end-to-end workflows | Evidence bundle for each release |

## Implementation Principles

1. Preserve source documents and calculations separately from editable views.
2. Persist approved rule sets and run inputs as immutable versions.
3. Require units, electrical basis, time basis and provenance on model inputs.
4. Enforce permissions and approval gates on the server, not just React buttons.
5. Label approximations, infeasibility, unsupported rules and stale outputs plainly.
6. Optimize the declared commercial objective; expose any secondary objective.
7. Reuse the current engine through an adapter before replacing its internals.
8. Treat document contents as data, never as instructions to execute code or tools.

## Definition Of Enterprise Ready

A second engineer can clone the repository, start a documented environment,
upload a fixture tender, review its amendment, reproduce an approved run, explain
each compliance result from source to calculation, export the same report twice,
and prove that another organization's documents and jobs are inaccessible.

Wireframes and documentation alone do not meet this definition. Release gates
and test evidence are specified in the accompanying documents.
