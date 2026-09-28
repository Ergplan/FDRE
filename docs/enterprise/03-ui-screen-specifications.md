# Enterprise UI And Wireframe Specification

This document specifies the new UI; it does not describe every prototype control
as production-ready. Keep Apache ECharts and the existing lucide icon family.
Use project-scoped routes and persistent state rather than one conditional tab tree.

## 1. Workspace Structure

```text
Organization switcher | Project / Version | Environment | Jobs | User
-------------------------------------------------------------------
Portfolio             | Breadcrumb and screen title
Project overview      | Version, approval and freshness status
Tender intelligence   | Main task area
  Documents           |
  Extraction review   | Context/evidence drawer when relevant
  Amendments          |
  Approved rules      |
Project setup         |
Yield assessment      |
  Solar / Wind / BESS  |
Commercial model      |
  Finance / Markets   |
Analysis              |
  Optimization        |
  Custom dispatch     |
  Validation          |
Results               |
  Dispatch            |
  Compliance          |
  Optimized EYA       |
  Financial statements|
  Sensitivity         |
Reports               |
Project history       |
Administration        |
```

The sidebar navigates screens. It does not duplicate sizing, financial or tender
inputs. Persist organization/project context in the URL; deep links identify the
project and, for results, a run ID. A global job tray survives route changes.

Use one fixed contracted-capacity input in Project Setup. Technology min/max
bounds live in Optimization. Fixed asset sizes live in Custom Dispatch. Never
label an input as both "limit / case" or reuse those state variables.

## 2. Visual And Interaction System

- Operational workspace, not a marketing landing page. Neutral white/light-grey
  canvas, dark green navigation, restrained teal actions, amber warnings, red errors.
- Define shared tokens for spacing (4/8/12/16/24/32 px), typography (12/14/16/20/24
  px), borders and status colors. Use 4-8 px radii for tools and panels.
- Default tables are compact, searchable, sortable and column-selectable. Wrap
  explanatory text; use a source drawer for long clauses. Pin identifiers and units.
- Numeric controls show unit, min/max, precision, basis and source. Sliders have
  synchronized numeric fields; keyboard entry can reach exact bounds.
- Currency display distinguishes INR, lakh and crore. Numbers are never silently
  rescaled when copying or exporting. Negative cash flows retain their sign.
- Only actionable commands use buttons. Icon-only controls have accessible labels
  and tooltips. Status must not depend on color alone.
- At desktop widths use a 240-280 px sidebar and an unframed main workspace.
  At tablet widths collapse navigation; on mobile use one content column and a
  drawer. Evidence and long tables remain usable without page-level overflow.
- Charts have named axes/units, legend toggles, accessible table alternatives,
  keyboard-accessible date controls and CSV/image exports where appropriate.
- Unsaved changes, stale results, unapproved rules, interpolated years and missing
  data are visible near the affected action, not hidden in a generic toast.

## 3. Global State Contract

Each screen designs loading, empty, populated, validation-error, permission-denied,
network-error and stale-version states. Long jobs also show queued, running,
cancelling, failed, time-limited and complete states. Failed fetches preserve form
values and expose retry. A zero result is distinct from unavailable data.

All results display the source project/rule/profile/finance versions, simulation
mode, run timestamp and active assumptions. Browser refresh restores server state.
Draft edits never overwrite the last completed run. Concurrent edits trigger a
version-conflict dialog with compare/reload/save-as-new-version options.

## 4. Screen Inventory

`P` below means `/projects/:projectId`. IDs are stable references for designers,
stories and end-to-end tests, not current implementation routes.

| ID | Route | Primary user | Main action | Release |
|---|---|---|---|---|
| UI-01 | `/projects` | Bid lead | Create/open project | E1 |
| UI-02 | `P/overview` | All | Resolve readiness gaps | E1 |
| UI-03 | `P/tender/documents` | Engineer | Upload and classify documents | E1 |
| UI-04 | `P/tender/review` | Reviewer | Correct/accept/reject facts | E1 |
| UI-05 | `P/tender/amendments` | Reviewer/approver | Resolve and approve changes | E1 |
| UI-06 | `P/tender/rules` | Modeller | Validate/approve executable rules | E1 |
| UI-07 | `P/setup` | Engineer | Save project configuration | E1 |
| UI-08 | `P/yield/solar` | EYA engineer | Approve solar profiles | E1 |
| UI-09 | `P/yield/wind` | EYA engineer | Approve wind profiles | E1 |
| UI-10 | `P/yield/bess` | EYA engineer | Approve storage assumptions | E1 |
| UI-11 | `P/finance/inputs` | Finance analyst | Save baseline assumptions | E1 |
| UI-12 | `P/markets` | Bid analyst | Approve market scenarios | E2 |
| UI-13 | `P/optimization` | Modeller | Submit sizing run | E1/E2 adapter dependent |
| UI-14 | `P/custom-dispatch` | Engineer | Simulate fixed sizes | E1/E2 adapter dependent |
| UI-15 | `P/runs/:runId/dispatch` | Engineer | Inspect interval dispatch | E1 |
| UI-16 | `P/runs/:runId/compliance` | Bid lead | Inspect each obligation | E1/E2 adapter dependent |
| UI-17 | `P/runs/:runId/eya` | EYA engineer | Generate optimized EYA | E1 |
| UI-18 | `P/runs/:runId/financials` | Finance analyst | Inspect statements and price buildup | E1 |
| UI-19 | `P/runs/:runId/sensitivity` | Finance analyst | Rerun finance on fixed sizing | E1 |
| UI-20 | `P/runs/:runId/validation` | Modeller/reviewer | Challenge winner and confirm full term | E1 |
| UI-21 | `P/reports` | Bid lead/client | Review, publish and download reports | E1 |
| UI-22 | `P/history` | All authorized users | Compare versions and runs | E1 |
| UI-23 | `/admin` | Admin | Manage users, templates and operations | E1 |

## 5. Detailed Screen Contracts

### UI-01: Portfolio

Layout: filter/search toolbar and project table; optional portfolio summary above.
Columns: project, tender family, issuer, bid MW, owner, next deadline, readiness,
last run, approval and updated date. Actions: create, open, archive, duplicate as
draft. A creation drawer requests name, owner, currency/timezone and tender package
or blank draft. Do not force an NHPC template on blank projects.
Acceptance: project lists and searches cannot cross tenant boundaries; archived
projects remain auditable; pagination and URL filters survive navigation.

### UI-02: Project Overview

Layout: project identity, readiness checklist, latest approved run and activity.
Show separate statuses for source review, rule implementation, resource quality,
finance completeness and run validation. Deadline cards cite the approved fact.
Actions: resume workflow, view last run, compare versions. The latest unsuccessful
attempt must not replace the last feasible winner without clear labels.
Acceptance: every blocked step links to a concrete missing input or unsupported rule.

### UI-03: Document Library

Layout: upload area, document/version table and selected-document details drawer.
Inputs: PDF/DOCX/text, role, issue/effective date, base tender link, parser preference.
Rows show hash, revision, pages, extraction engine, coverage, warnings and job status.
Actions: upload, extract/retry failed pages, open original, mark superseded.
Do not delete documents referenced by approved runs. Duplicate uploads do not
erase decisions. Partial/OCR failure remains visible. Acceptance: both supplied
CfD files can coexist; cancellation and retry cannot create conflicting versions.

### UI-04: Extraction Reviewer

```text
Document/version | reviewer queue | progress | save draft / submit review
-----------------------------------------------------------------------
Field list      | Original value + proposed value | Original PDF / text
Group/status    | Unit, basis and origin          | Physical/printed page
Conflicts       | Evidence references             | Bounding-box highlight
                | Correction + reason            | Search / next match
                | Accept / reject / flag conflict| Table/native-text toggle
```

Fields show source-derived, inferred, defaulted or missing provenance. A score is
an extraction hint, never an approval. Include monetary formulas, dates, eligibility,
technical conditions and not-yet-modelled clauses, not just mapped inputs.
Actions are authenticated and server-persisted; corrected values retain originals.
Acceptance: editing an accepted value requires re-review; source citations point
to the correct physical page; two simultaneous reviewers receive a revision conflict.
The application never changes model inputs merely because a file was parsed.

### UI-05: Amendment Comparison

Layout: base clause, amendment clause and proposed consolidated interpretation.
Inputs: target document type/clause, effective date, add/replace/delete/clarify,
reviewer note. Show unresolved matches, differing units and impacted model rules.
Actions: propose operation, resolve conflict, submit independent approval, publish
new rule version. Acceptance: RfS 9.3.a.iv and CfDA 9.2.iv remain distinct targets;
an unrelated clause is not replaced because it contains similar keywords.

### UI-06: Approved Rules

Layout: capability summary plus rule table grouped by delivery, eligibility,
settlement, penalties and milestones. Columns: rule ID, typed value, unit,
aggregation, effective period, source, approval and implementation status.
Actions: validate compilation, view gaps, compare versions, approve/freeze.
Acceptance: non-FDRE/unknown rules do not inherit 40% CUF, 90% monthly availability
or a 25-year term; optimization blocks on missing critical implementations.

### UI-07: Project Configuration

Sections: one fixed bid MW; site coordinates and technology checkboxes; grid nodes,
PoI limit and electrical basis; project calendar; enabled assets; schedule policy.
Show approved tender rules read-only with a route to create a reviewed change.
User assumptions remain editable and distinguished from tender requirements.
Actions: validate and save draft/version. Acceptance: procurement quantum is
not confused with selected bid capacity; disabling wind removes wind variables;
limits and initial sizes are not entered here as duplicate ambiguous controls.

### UI-08: Solar Assessment

Layout: site selector and overview, PVsyst ingestion/quality, loss chain, P-levels
and normalized profile charts. Initial UI supports up to three sites; persist sites
as entities so the database does not hardcode three columns.
Inputs: site identity, AC/DC ratings and ratio, report/profile, uncertainty,
degradation and loss inclusion. Show 1 MW AC yield, monthly CUF, clipping and
P50/P75/P90/P95 provenance. Actions: map columns, correct units, approve profile.
Acceptance: site-specific sizing/profile assignments survive optimization and
downstream reports; system losses are not subtracted again from already-net profiles.

### UI-09: Wind Assessment

Layout: measurement -> long-term climate -> flow/layout -> gross AEP -> losses ->
net AEP -> uncertainty, with a status/source at each step. Unsupported MCP/CFD/wake
calculations are shown as externally supplied results, not simulated by the app.
Inputs: turbine rating/power curve, count/layout, hub height, wind/weather profile,
measured-generation CSV, loss groups, uncertainty and scenario name.
Charts: duration/power curve, wind rose if directional data exists, loss waterfall,
monthly production, uncertainty distribution and site layout when coordinates exist.
Acceptance: a 3.15 MW turbine input is normalized to a traceable 1 MW basis; no
invented 16-turbine count; optimized park output reflects turbine-count policy.

### UI-10: BESS Assessment

Inputs: PCS efficiency, charge/discharge efficiency or RTE with an explicit split,
DoD/SOC limits, availability, C-rate, auxiliary load, nameplate/usable basis,
SoH calendar/cycle degradation and augmentation/replacement cohorts.
Charts: usable energy and RTE by year, cohort additions and operating envelope.
Actions: choose manufacturer schedule, edit assumptions, validate consistency.
Acceptance: DoD is not deducted twice; year-11 reset is not universal; no gratuitous
annual SOC reset; a forced two-hour case requires energy=2 x power within bounds.

### UI-11: Financial Inputs

One baseline form, grouped into technology capex, development/land, connectivity,
opex, augmentation cost, debt, cost of equity, tax, working capital and revenue.
Each cost states per-MW/per-MWh/fixed basis, escalation, valuation date and source.
Show a live cost buildup for a selected design without rescheduling it. Market
prices link to UI-12 rather than being duplicated here.
Acceptance: zero debt is valid; cost of equity is visible; units and project-size
scaling reconcile; sensitivity uses baseline references rather than duplicate forms.

### UI-12: Markets And Commercial Scenarios

Inputs: exchange/time-block prices, clearing assumptions, fees, imbalance rules,
REC prices/sharing, external green cost and tender settlement adapter. Distinguish
forecast/day-ahead information from realized values and perfect-foresight studies.
Charts: monthly/hourly price distribution, selected-block price curve, settlement
slabs and scenario ranges. Missing prices block a CfD price run.
Acceptance: time index aligns with dispatch; negative prices and slab boundaries
are tested; scenario names do not masquerade as assured future income.

### UI-13: Optimization

Layout: readiness gate, objective selector appropriate to family, fixed bid MW
summary, technology/site bounds, solver controls, job progress and candidate results.
Bounds use sliders plus numeric boxes. Show engine-received inputs before submit.
Outputs: per-site solar, turbine count/MW, BESS MW/MWh, tariff or strike price,
IRR/DSCR, spill, feasibility, objective breakdown and bound/gap when meaningful.
Acceptance: a time-limited feasible incumbent is labelled as such; unsupported
rules block; no hidden capex/spill penalty changes a stated minimum-tariff objective.

### UI-14: Custom Dispatch

Inputs: fixed solar per site, wind, BESS MW/MWh, contracted MW, approved schedule,
profile case and simulation horizon. No financial/tariff inputs required.
Always retain the submitted sizes. If infeasible, solve a documented best-effort
delivery objective and show the remaining shortfall; do not resize assets secretly.
Outputs: hourly/interval chart, SOC and compliance matrix. Acceptance: run works
with zero BESS; missing profiles cause validation errors rather than synthetic substitution.

### UI-15: Dispatch Cockpit

Full-width chart above compact diagnostic tables. Date presets: day/week/month/year,
peak selector, timezone and resolution. ECharts shows generation/direct supply,
charging/discharging, export/merchant/spill; SOC uses a separate aligned panel or
explicit energy axis. No mixing MWh and MW on an unlabeled shared axis.
Add end-of-peak SOC, next obligation, available headroom and binding-constraint
explanation. Acceptance: 15-minute and hourly data retain correct energy integrals;
zoom queries finer data and exports full-resolution source series.

### UI-16: Compliance Dashboard

Rule matrix: obligation, required, achieved, margin, period, exception, penalty,
status and source. Drill through annual -> month -> week/day -> interval according
to the rule, rather than forcing all rules into monthly tables.
Charts: calendar shortfall heatmap and obligation/delivery comparison. Include
eligible external green and curtailment adjustments as separate ledger entries.
Acceptance: CfD weekly failure cannot be hidden by a monthly surplus; approved
exception quantities reconcile to source intervals and do not double-count energy.

### UI-17: Optimized EYA

Show the approved component assessments scaled to the selected portfolio and
then hybrid dispatch results. Include gross/net AEP, loss waterfall, uncertainty,
P-level assumptions, BESS usable-energy/RTE schedules, annual annexures, monthly
shortages, storage flows and report methodology differences.
Actions: compare P-levels, drill into a site, export tables and report draft.
Acceptance: portfolio P90 is not silently the sum of independent site P90 values;
correlation assumptions and stochastic vs deterministic scaling are disclosed.

### UI-18: Financial Statements

Tabs within the screen: revenue/settlement buildup, P&L, cash flow, debt/DSCR,
working capital, project/equity returns and model explanation. CfD uses its own
settlement ledger. Charts: stacked revenue/costs, cash-flow bars, debt balance,
DSCR and cumulative equity cash flow.
Acceptance: year zero, augmentation years and final working-capital release are
visible; all tables reconcile; IRR unavailable/nonunique states are explicit.

### UI-19: Sensitivity And Scenarios

Title: **Fixed Optimized Sizing Finance Rerun**. Subtitle: **Only finance assumptions
change**. Pin parent run and frozen capacities/dispatch hash above the controls.
Controls: permitted financial overrides with sliders/numeric entries, named
scenarios, fixed-price vs recompute-required-price mode, reset to parent baseline.
Charts: tornado, selected two-variable heatmap, IRR/DSCR and cash-flow comparison.
Acceptance: changes do not call sizing/dispatch; new optimization creates a new
baseline and archives previous active comparisons; late responses cannot replace it.

### UI-20: Optimizer Validation

Show winner, bounds hit, +/-5% and +/-10% perturbations, nearby grid heatmap,
top ten feasible alternatives, near-misses with quantitative violations, and full
contract confirmation. Report any better alternative found without declaring the
original winner optimal. Confidence is an evidence grade with an explanation,
not a numerical solver optimality certificate.
Acceptance: same constraints/inputs/tolerances for all alternatives; integer turbine
and fixed-duration policies are respected during perturbations.

### UI-21: Reports And Exports

Template picker: tender review, bid summary, custom-dispatch Joulewise EYA,
optimized EYA, compliance, financial model and validation. Collect client/project,
engineer/reviewer, methodology and missing narrative inputs on screen.
Preview sections and mark missing data. Preserve detailed tables, annexures,
assumptions and graphics; do not silently omit sections because a run is infeasible.
Downloads: PDF/DOCX/HTML as supported by implemented renderers, CSV/XLSX matrices,
full interval artifacts and versioned run manifest. Distinguish reference report
ingestion from recalculated project reports. Acceptance: published report numbers
match the pinned run, and draft assumptions appear clearly.

### UI-22: History And Comparison

Timeline of uploads, decisions, rule publications, project edits, runs and reports.
Compare input and result versions side by side with actor/reason. Actions: open
historical run, branch as draft, compare scenarios, download audit evidence.
Acceptance: no action rewrites approved history; deletions use retention policy;
stale historical runs are reproducible and visibly labelled.

### UI-23: Administration

Organization users/project roles, approval policies, tender-adapter registry,
report templates, worker quotas, job health, model/cache versions and retention.
Actions are permission-checked and audited. Display adapter capability/validation
versions so enabling an adapter cannot bypass release gates.
Acceptance: read-only clients cannot change assumptions or download unauthorized
sources; admin support actions cannot impersonate a reviewer without audit.

## 6. Designer Deliverables

Create a shared component library, route/navigation map, low-fidelity wireframes
for UI-01 through UI-23 and an interactive high-fidelity prototype of three journeys:
NHPC bid sizing, CfD document/amendment review, and fixed-sizing finance sensitivity.

For each screen deliver a populated state using fixture data, empty state,
validation failure, async/loading state, permission state and mobile variant.
Annotate component-to-field/API mappings and what changes invalidate prior results.
Complete the keyboard/focus/error-message walkthrough before engineering handoff.

Use real document excerpts in controlled design fixtures; invented figures must
be visibly labelled sample data. Do not present an unimplemented solver output
as an actual optimized result in a client prototype.
