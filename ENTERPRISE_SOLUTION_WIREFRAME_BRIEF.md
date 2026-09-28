# FDRE Enterprise Platform Solution & Wireframe Brief

Version: 0.1  
Date: 20 July 2026  
Product: FDRE Optimizer, Energy Yield Assessment and Bid Intelligence Platform  
Audience: Product, design, engineering, commercial, technical advisory and client-demo stakeholders

## 1. Product Vision

Build an enterprise-grade FDRE bidding and project assessment platform that converts tender documents, site data, yield reports, BESS assumptions and financial inputs into optimized renewable-plus-storage project configurations.

The platform should help a developer answer:

- What does the tender require?
- What site and technology assumptions are being used?
- What is the 1 MW yield basis for solar, wind and BESS operation?
- What solar, wind and BESS sizing gives the least required tariff for a target equity IRR?
- Does the optimized solution satisfy tender conditions over the full 25-year PPA?
- What happens if we change only finance assumptions while keeping optimized sizing fixed?
- How do custom capacities perform against CUF, peak availability and dispatch obligations?
- Can we generate bankable, client-ready reports with traceable assumptions, graphs and annexures?

## 2. Target Users

### Bid Strategy Lead

Needs a fast view of tender obligations, required bid capacity, tariff, sensitivity and near-miss cases.

### Technical / EYA Engineer

Needs traceable solar, wind and BESS yield inputs, loss waterfalls, uncertainty, P-level energy and 8760 dispatch outputs.

### Finance / Investment Analyst

Needs capex, opex, debt, tax, working capital, DSCR, equity IRR, project IRR, statements and scenario reruns without accidentally changing project sizing.

### Management / Client Reviewer

Needs polished dashboards, clear pass/fail compliance status, executive summaries and downloadable reports.

### Admin / Enterprise Operator

Needs version control, project history, permissions, audit logs, approved assumptions and export governance.

## 3. Enterprise Product Principles

- One source of truth: tender conditions and project configuration should be captured once, edited visibly, and reused by optimizer, dispatch, finance and reports.
- No hidden assumptions: every material tariff driver must be visible in input sheets or report annexures.
- Separate physical optimization from finance rerun: sensitivity changes can change tariff and returns, but must not resize solar, wind or BESS unless the optimizer is explicitly rerun.
- Dispatch first, finance second: tender compliance depends on physical dispatch, SOC, CUF and availability before tariff can be solved.
- Bankable traceability: every result should be reproducible from a saved case version, input files, solver settings and model version.
- Progressive disclosure: executive screens stay clean, analyst screens expose full tables, hourly data and diagnostics.

## 4. Recommended Application Navigation

Use a left sidebar with sequential workflow groups. Each group can expand into sub-screens.

```text
1. Tender Upload
2. Project Configuration
   - Project & Site
   - Tender Conditions
   - Technology Options
   - Grid Interconnection
   - BESS Operating Assumptions
   - Optimizer Search Bounds
3. Yield Assessment
   - PVsyst Solar
   - Wind EYA
   - BESS Technical Assessment
   - 1 MW Yield Basis
4. Financial Inputs
   - Capex & Opex
   - Financing
   - Tax & Working Capital
   - BESS Augmentation
   - Model Explanation
5. Optimization
6. Optimizer Validation
7. Optimized EYA
8. Custom Dispatch
9. Financial Statements
10. Sensitivity & Scenarios
11. Results Dashboard
12. Reports & Exports
13. Case Management
14. Admin & Governance
```

## 5. End-to-End User Journey

### Journey A: Bid Optimization

1. Upload tender.
2. Review parsed tender conditions.
3. Confirm project configuration and site coordinates.
4. Upload PVsyst reports for up to three solar sites.
5. Upload or select wind 8760 generation profile.
6. Confirm BESS technical assumptions.
7. Enter financial assumptions.
8. Run optimizer for a fixed contracted capacity.
9. Review optimal sizing, tariff and tender compliance.
10. Run optimizer validation and near-miss review.
11. Generate optimized EYA and bid report.

### Journey B: Custom Sizing Dispatch

1. Enter custom solar, wind, BESS MW and BESS MWh.
2. Select peak windows and tender thresholds.
3. Run dispatch only.
4. Review CUF, monthly peak availability, shortfalls, SOC curve and spill.
5. Generate custom Joulewise-style EYA report.

### Journey C: Finance Sensitivity

1. Start from optimized sizing.
2. Change debt, cost of equity, DSCR, capex, opex or working capital.
3. Rerun finance only.
4. Compare tariff, equity IRR, DSCR, cash flows and statements.
5. Save scenario without changing optimized capacities.

## 6. Screen Wireframe Specifications

## Screen 1: Tender Upload

### Purpose

Ingest tender documents and extract bid-relevant obligations.

### Primary Layout

- Header: Tender Upload and Parse
- Left panel: file upload area
- Right panel: parse status and extracted summary
- Bottom: detailed tender condition table

### Key Components

- Upload control for PDF/DOCX
- Parse status cards:
  - Tender name
  - Tender size
  - Procurer / buying entity
  - Allowed location
  - ISTS / CTU requirements
  - Bid capacity rules
  - PPA term
  - Peak-hour obligation
  - Annual CUF band
  - Penalty formula
  - EMD, PBG, processing fee and success fee
- Key timeline table:
  - Bid submission
  - Pre-bid
  - E-reverse auction
  - Financial closure
  - SCOD
  - PPA execution
- Technical/commercial strategy notes:
  - Compliance risk
  - Storage sizing implications
  - Location freedom
  - Grid interconnection risk
  - Finance/bid-security impact

### Wireframe Notes

- Tender summary should feel like an analyst memo, not just OCR text.
- Each extracted condition should show confidence: High / Medium / Needs Review.
- User can click "Apply to Project Configuration".

### Acceptance Criteria

- Uploaded tender is stored as part of the case.
- Parsed constraints flow to Project Configuration.
- User can override every extracted value.

## Screen 2: Project Configuration

### Purpose

Define the physical and tender assumptions used by dispatch, optimizer and reports.

### Primary Layout

- Top: project status strip
- Main: editable sections in accordions
- Right rail: live validation checklist

### Sections

### Project & Bid

- Project name
- Case name
- Developer / client
- State / region
- Bid capacity MW as a single fixed input
- Declared annual CUF %
- PPA term
- Solve mode: fast representative years / exact 25-year

### Tender Conditions

- Minimum peak availability %
- Annual CUF minimum %
- CUF lower tolerance %
- CUF upper purchase tolerance %
- Green support allowed %
- Penalty multiplier
- Hard compliance toggle

### Peak Schedule

- Morning peak start, default 08:00
- Morning peak end, default 10:00
- Evening peak start, default 18:00
- Evening peak end, default 20:00
- Option to stress-test buyer schedule within allowed tender windows

### Technology Options

Use checkboxes:

- Solar enabled
- Wind enabled
- BESS enabled
- Hybrid mandatory
- External green support allowed
- Force 2-hour BESS test mode

### Site Coordinates

- Solar site 1 latitude / longitude
- Solar site 2 latitude / longitude
- Solar site 3 latitude / longitude
- Wind site latitude / longitude
- BESS / pooling station
- Map preview placeholder

### Grid Interconnection

- Pooling station
- ISTS node
- Interconnection limit MW
- Transmission loss %
- Grid availability %
- Evacuation bottleneck notes

### BESS Operating Assumptions

- Round-trip efficiency %
- Depth of discharge %
- Availability %
- Initial SOC %
- Minimum reserve SOC %
- Degradation / SoH curve selection
- Augmentation strategy

### Optimizer Search Bounds

Slider bars:

- Solar AC MW min/max
- Wind MW min/max
- BESS power MW min/max
- BESS energy MWh min/max

The contracted capacity is not a range. It is a fixed bid capacity input.

### Acceptance Criteria

- Search bounds cannot contradict disabled technologies.
- Project Configuration is the single source of truth.
- Changing peak windows affects optimizer and custom dispatch.
- Force 2-hour BESS binds BESS MWh = 2 x BESS MW during optimization.

## Screen 3: Yield Assessment

### Purpose

Build 1 MW AC yield inputs for optimizer and dispatch.

### Primary Layout

- Tabs within screen: Solar PVsyst, Wind EYA, BESS, Hybrid Yield Basis
- Each resource shows input, methodology, results and download.

### Solar PVsyst

Support up to three uploaded PVsyst reports.

Components:

- Upload card per solar site
- Site metadata:
  - Site name
  - AC capacity
  - DC capacity
  - DC/AC ratio
  - GHI
  - ambient temperature
  - module/inverter details
  - degradation
- P-level selector:
  - P50
  - P75
  - P90
- Extracted outputs:
  - Annual generation
  - AC CUF
  - DC CUF
  - Monthly generation
  - Loss waterfall
  - Uncertainty
- Controls:
  - Use selected P-level as optimizer solar CUF
  - Include/exclude site in optimization

### Wind EYA

Enterprise wind assessment flow:

```text
Wind Measurements
↓
Long-Term Wind Climate (MCP)
↓
Flow Modelling (WAsP/OpenWind/CFD)
↓
Micrositing & Turbine Layout
↓
Gross AEP
↓
Wake Losses
↓
Availability Losses
↓
Electrical Losses
↓
Environmental & Curtailment Losses
↓
Net AEP
↓
Uncertainty Analysis
↓
P50 / P75 / P90 / P95
```

Components:

- Upload 8760 generation profile or wind resource file
- Turbine input:
  - Manufacturer
  - Model
  - Rated power
  - Rotor diameter
  - Hub height
  - IEC class
  - Cut-in / rated / cut-out speed
- Layout input:
  - Number of turbines
  - Coordinates
  - spacing
  - wake groups
- Loss waterfall:
  - wake
  - electrical
  - availability
  - environmental
  - grid curtailment
  - degradation
- Uncertainty:
  - measurement
  - long-term correlation
  - power curve
  - wake model
  - terrain
  - electrical
  - availability
  - curtailment
  - combined RSS
- Outputs:
  - Gross AEP
  - Net AEP
  - Capacity factor
  - Specific yield
  - Monthly energy
  - 8760 profile
  - P50, P75, P90, P95

### windpowerlib Use

Use `wind-python/windpowerlib` as an optional calculation engine for wind generation from weather and turbine data.

Recommended use:

- Store windpowerlib as a backend service module.
- Inputs:
  - hourly wind speed
  - temperature
  - pressure / density
  - roughness
  - hub height
  - turbine model or power curve
- Outputs:
  - 8760 turbine generation
  - wind farm generation
  - capacity factor
  - monthly and annual energy
- Then pass normalized 1 MW hourly capacity factors into the FDRE dispatch engine.

### BESS Assessment

Components:

- BESS technology
- PCS MW
- energy MWh
- C-rate
- RTE
- DoD
- SoH schedule
- augmentation schedule
- availability
- auxiliary load
- charge/discharge constraints

Outputs:

- usable MWh by year
- RTE by year
- available power by year
- degradation chart
- 2-hour / 4-hour test comparison

### Acceptance Criteria

- Solar and wind yield basis are normalized to 1 MW before optimization.
- User can choose P50/P75/P90 inputs.
- Uploaded yield files are listed in reports.
- BESS assumptions flow to dispatch and finance.

## Screen 4: Financial Inputs

### Purpose

Capture all finance assumptions in one place.

### Primary Layout

- Left: assumption forms
- Right: live assumption summary and model explanation
- Bottom: full assumptions table

### Sections

### Capex

- Solar EPC Rs cr/MW AC
- Wind EPC Rs cr/MW
- BESS PCS Rs cr/MW
- BESS battery Rs cr/MWh
- Land Rs cr/MW solar
- Development Rs cr/MW
- Transmission/connectivity Rs cr/MW
- Owner's costs Rs cr/MW or % capex
- Contingency %
- IDC settings

### Opex

- Solar O&M Rs lakh/MW/year
- Wind O&M Rs lakh/MW/year
- BESS O&M Rs lakh/MW/year
- Transmission charges Rs lakh/MW/year
- Transmission losses %
- Admin opex
- Insurance %
- Escalation %

### Financing

- Debt %
- Debt interest rate
- Debt tenor
- Moratorium
- Repayment style: sculpted / annuity
- Sculpt target DSCR
- Size debt by DSCR toggle
- Cost of equity / target equity IRR

### Tax

- Tax rate
- MAT / regular tax treatment if needed
- WDV depreciation
- Book depreciation
- Loss carry-forward

### Working Capital

- Receivable days
- Payable days
- O&M payable days
- Working capital interest rate
- DSRA months

### BESS Augmentation

- Enable annual or scheduled augmentation
- Start year
- Annual addition %
- Cost decline %
- Floor cost Rs cr/MWh
- Physical usable MWh addition
- Finance capex addition

### Model Explanation

Show a read-only finance model sheet:

- Revenue build-up
- Opex
- EBITDA
- Working capital
- Tax
- CFADS
- Debt service
- DSCR
- FCFE
- IRR
- Tariff bisection

### Acceptance Criteria

- Financial inputs flow into optimizer tariff solve.
- Finance-only rerun changes financial outputs only.
- Optimized capacities remain locked unless Optimization is rerun.

## Screen 5: Optimization

### Purpose

Find least required tariff for a fixed contracted capacity and target equity IRR.

### Primary Layout

- Header: run controls
- Top cards: optimized capacities and tariff
- Middle: compliance dashboard
- Bottom: dispatch and sizing charts

### Inputs

- Fixed contracted capacity MW
- Target equity IRR
- Solver effort: fast / balanced / thorough
- Exact 25-year confirmation toggle
- Technology search bounds
- Force 2-hour BESS toggle
- P-level selection from yield assessment

### Outputs

- Solar MW
- Wind MW
- BESS MW
- BESS MWh
- BESS duration
- Required gross tariff
- Equity IRR
- Project IRR
- Min DSCR
- Annual CUF
- Monthly peak availability
- Spill / curtailment
- CAPEX
- LCOE-style summary

### Solver Objective

Find the lowest tariff that achieves the target equity IRR while satisfying hard tender compliance, DSCR and physical dispatch constraints.

### Acceptance Criteria

- Contracted capacity is fixed, not optimized across a range.
- Optimizer must evaluate full dispatch before solving tariff.
- If infeasible, output must explain physical reason and nearest feasible direction.
- SOC chart must reveal unused BESS energy, spill and charge/discharge behavior.

## Screen 6: Optimizer Validation

### Purpose

Prove whether the optimizer result is credible or whether nearby cheaper solutions exist.

### Required Sections

| Check | Output |
| --- | --- |
| Winner summary | selected solar, wind, BESS, tariff |
| Bounds hit test | whether any variable is at min/max |
| Local perturbation matrix | +/-5%, +/-10% tariff/compliance results |
| Grid search heatmap | best nearby alternatives |
| Full 25-year confirmation | tariff, IRR, DSCR, compliance |
| Top 10 feasible alternatives | sorted by tariff |
| Top infeasible near-misses | failed reason and gap |
| Confidence score | strong / moderate / weak |

### Near-Miss Table Columns

- Candidate
- Solar MW
- Wind MW
- BESS MW
- BESS MWh
- Tariff if finance-solvable
- Monthly peak availability
- Annual CUF
- Penalty energy
- Failure reason
- Required repair

### Acceptance Criteria

- Shows both feasible alternatives and infeasible near-misses.
- Flags if winner is at search bound.
- Allows download of validation matrix.

## Screen 7: Optimized EYA

### Purpose

Convert optimized sizing into a full energy yield assessment.

### Primary Layout

- Executive summary
- Optimized technology sizing
- Solar EYA scaled from PVsyst
- Wind EYA scaled from selected profile
- BESS annual SoH/RTE and dispatch
- Hybrid annual and monthly assessment
- P50/P75/P90/P95 comparison

### Outputs

- 25-year annual generation
- annual CUF
- monthly peak availability
- annual availability matrix
- PPA energy
- charge/discharge energy
- curtailment
- spill
- BESS SOC profile
- degradation
- uncertainty bands

### Acceptance Criteria

- Uses optimized solar, wind and BESS sizes.
- Uses selected yield P-level.
- Shows tender compliance fulfillment as pass/fail with reasons.

## Screen 8: Custom Dispatch

### Purpose

Run dispatch for manually entered capacities without tariff or finance.

### Inputs

- Contracted MW
- Solar MW
- Wind MW
- BESS MW
- BESS MWh
- Morning peak start/end, default 08:00-10:00
- Evening peak start/end, default 18:00-20:00
- Minimum peak availability, default 90%
- Minimum annual CUF, default 40%
- Yield P-level
- Exact / representative years

### Outputs

- Pass/fail tender dashboard
- Best-effort dispatch result
- Monthly availability
- Annual CUF
- Shortfall energy
- Peak shortfall
- Spill / curtailment
- BESS charge/discharge/SOC
- Hourly dispatch curve
- 25-year hourly dispatch download

### Acceptance Criteria

- Always runs dispatch even if conditions fail.
- Clearly separates physical shortfall from finance.
- Does not show tariff.
- Peak windows are user editable.

## Screen 9: Financial Statements

### Purpose

Show full financial model outputs for optimized or finance-rerun case.

### Sections

- Revenue build-up
- PPA revenue
- Merchant revenue
- Penalties
- Green support cost
- O&M
- EBITDA
- Depreciation
- Interest
- Tax
- PAT
- CFADS
- Debt service
- DSCR
- FCFE
- Equity IRR
- Project IRR
- NPV

### Graphs

- Revenue stack
- EBITDA and PAT
- Debt service and DSCR
- FCFE
- Capex and augmentation
- Tax shield / depreciation

### Acceptance Criteria

- Downloadable annual statement table.
- Shows assumptions used for the statement.
- Explains any negative cash flow from augmentation.

## Screen 10: Sensitivity & Scenarios

### Purpose

Change assumptions while keeping optimized physical sizing fixed.

### Inputs

- Debt %
- Debt rate
- Cost of equity / target IRR
- Min DSCR
- Debt sizing DSCR
- Scenario name

Future scenario groups:

- capex scenario
- opex scenario
- merchant price scenario
- degradation scenario
- BESS augmentation scenario

### Outputs

- Tariff movement chart
- Equity IRR
- Min DSCR
- NPV
- Side-by-side comparison against base optimized case
- Scenario tornado chart

### Acceptance Criteria

- The heading must say: "Fixed optimized sizing finance rerun".
- Screen must clearly say: "Only finance assumptions change".
- Does not alter solar, wind or BESS capacity.
- Optimizer output resets sensitivity base after a new optimization run.

## Screen 11: Results Dashboard

### Purpose

Executive summary of the selected case.

### Layout

- Hero row:
  - Tariff
  - Solar MW
  - Wind MW
  - BESS MW/MWh
  - Bid capacity
  - Compliance status
- Charts:
  - Hourly dispatch
  - SOC
  - Monthly peak availability
  - Annual generation/CUF
  - Revenue and DSCR
- Tables:
  - Project sizing
  - Compliance summary
  - Finance summary
  - Top risks

### Acceptance Criteria

- Must be boardroom-ready.
- Should avoid showing irrelevant infeasible current-sidebar case if optimized output exists.
- Must show selected case type: optimized / custom / scenario.

## Screen 12: Reports & Exports

### Purpose

Generate client deliverables and audit files.

### Report Types

- Tender parse summary
- Optimized bid report
- Optimized EYA report
- Custom dispatch Joulewise EYA report
- Finance model report
- Optimizer validation report
- Full data room export

### Downloads

- 25-year hourly dispatch CSV
- yearly dispatch CSV
- monthly compliance CSV
- annual generation/CUF/availability matrix
- finance statements CSV
- optimizer validation matrix
- assumptions JSON
- report package JSON
- printable HTML/PDF report

### Acceptance Criteria

- Every report has source file list and model version.
- Report numbers reconcile to screen outputs.
- Downloaded files include timestamp and case name.

## Screen 13: Case Management

### Purpose

Enterprise users need multiple saved cases, scenarios and audit history.

### Components

- Project list
- Case list
- Scenario list
- Version history
- Duplicate case
- Lock approved case
- Compare cases
- Archive case

### Metadata

- Owner
- Created date
- Last modified date
- Model version
- Source tender
- Source PVsyst reports
- Source wind file
- Approval status

### Acceptance Criteria

- Cases are reproducible.
- Approved cases cannot be silently overwritten.
- User can compare optimized vs custom vs scenario cases.

## Screen 14: Admin & Governance

### Purpose

Support enterprise controls.

### Components

- Users and roles
- Model version management
- Approved assumption libraries
- Tariff benchmark library
- Tender template library
- Audit logs
- Export permissions
- Data retention

### Roles

- Viewer
- Analyst
- Engineer
- Finance reviewer
- Approver
- Admin

### Acceptance Criteria

- Sensitive finance assumptions can be permissioned.
- All exports are logged.
- Model changes are versioned.

## 7. Global UI Components

### Sidebar

- Workflow steps with icons
- Active step highlight
- Run optimizer button
- Case status indicator
- Last saved timestamp

### Top Status Bar

- Case name
- Tender status
- Yield status
- Finance status
- Optimizer status
- Compliance status

### Cards

- Metric cards for tariff, MW, MWh, IRR, DSCR, CUF and availability
- Keep dense, restrained and readable

### Tables

- Sortable
- Filterable
- Downloadable
- Show units in headers
- Use conditional formatting for pass/fail

### Charts

Use Apache ECharts for polished dispatch and finance charts:

- line chart for hourly dispatch and SOC
- stacked area for generation/charging/discharging
- heatmap for grid search
- waterfall for losses and cash movement
- bar/line combo for revenue and DSCR
- tornado for sensitivity

### Empty States

- No tender uploaded
- No PVsyst report uploaded
- No wind file loaded
- Optimizer not run
- Infeasible case
- Finance unavailable

Each empty state should explain the next action.

## 8. Data Model Requirements

### Project

- project id
- case id
- scenario id
- project name
- client
- location
- tender id
- model version
- status

### Tender Conditions

- contracted capacity
- peak windows
- minimum peak availability
- annual CUF floor
- declared CUF
- CUF lower/upper band
- penalties
- allowed green support
- PPA term
- bid security assumptions

### Yield Inputs

- solar sites
- PVsyst source files
- selected P-level
- monthly generation
- hourly profile
- wind source file
- wind loss waterfall
- BESS SoH/RTE

### Technology Sizing

- solar MW AC by site
- wind MW
- BESS MW
- BESS MWh
- BESS duration
- interconnection limit

### Finance Assumptions

- capex
- opex
- financing
- tax
- working capital
- augmentation
- merchant price
- escalation

### Results

- dispatch
- compliance
- tariff
- IRR
- DSCR
- statements
- validation
- reports

## 9. Backend / API Map

Existing API concepts should be formalized into versioned endpoints.

### Existing

- `GET /api/defaults`
- `GET /api/eya`
- `POST /api/evaluate`
- `POST /api/optimize`
- `POST /api/optimizer/validate`
- `POST /api/pvsyst/parse`
- `POST /api/tender/parse`
- `POST /api/export/full-dispatch`

### Proposed Enterprise

- `POST /api/v1/projects`
- `GET /api/v1/projects/{project_id}`
- `POST /api/v1/cases`
- `POST /api/v1/cases/{case_id}/tender/parse`
- `POST /api/v1/cases/{case_id}/yield/pvsyst`
- `POST /api/v1/cases/{case_id}/yield/wind`
- `POST /api/v1/cases/{case_id}/dispatch/custom`
- `POST /api/v1/cases/{case_id}/optimize`
- `POST /api/v1/cases/{case_id}/finance/rerun`
- `POST /api/v1/cases/{case_id}/validate`
- `POST /api/v1/cases/{case_id}/reports`
- `GET /api/v1/cases/{case_id}/exports/{export_id}`

## 10. Model Logic To Preserve

- HiGHS-seeded optimization.
- Fixed contracted capacity for main optimizer.
- Peak hours as two morning hours and two evening hours.
- Monthly 90% peak availability check.
- Annual CUF lower and upper band logic.
- Hard compliance mode.
- 25-year exact dispatch confirmation.
- 25-year hourly dispatch export.
- BESS SOC continuity.
- BESS RTE, DoD, availability and SoH schedules.
- Optional force 2-hour BESS test.
- DSCR-sculpted repayment.
- Debt sized by DSCR capacity.
- Finance rerun without changing physical sizing.
- Optimizer validation with feasible and near-miss cases.

## 11. Wireframe Design Direction

### Visual Style

- Enterprise, analytical, polished.
- Dense but not cramped.
- Avoid decorative gradients and unused marketing space.
- Use a calm professional palette:
  - deep green / teal for energy
  - charcoal for text
  - white/off-white surfaces
  - amber for warnings
  - red for failed compliance
  - blue for finance

### Layout Rules

- Sidebar navigation remains persistent.
- Use full-width dashboard bands.
- Avoid nested cards.
- Keep forms grouped in clear accordions.
- Every chart should have unit labels.
- Every compliance output should have required, actual and status.

### Demo Story

The first client demo should follow:

1. Upload tender.
2. Confirm project configuration.
3. Upload yield reports.
4. Run optimization.
5. Prove compliance.
6. Stress-test finance.
7. Generate report.

## 12. Phase Plan

### Phase 1: Wireframe Foundation

- Finalize sidebar information architecture.
- Create low-fidelity wireframes for all screens.
- Define shared table, chart, card and form components.
- Define report templates.

### Phase 2: Enterprise UX Build

- Replace demo layouts with production screen structure.
- Add case status and save/load shell.
- Improve ECharts dispatch cockpit.
- Build report previews.

### Phase 3: Model Traceability

- Add model versioning.
- Add assumption diff.
- Add solver run log.
- Add source-file manifest.
- Add full audit exports.

### Phase 4: Enterprise Controls

- Add user roles.
- Add approvals.
- Add locked cases.
- Add audit logs.
- Add assumption library.

## 13. Wireframe Checklist

For each screen, wireframes must define:

- Main purpose
- Primary user action
- Inputs
- Outputs
- Empty state
- Error state
- Download/export action
- Linked upstream data
- Linked downstream screens
- Acceptance criteria

## 14. Open Product Decisions

- Should the platform optimize only for least tariff, or also offer lowest capex and highest compliance-margin modes?
- Should contracted capacity always be fixed for enterprise workflow, with portfolio-level bid strategy handled separately?
- Should PVsyst reports be stored as source PDFs plus parsed JSON?
- Should windpowerlib be enabled only for weather-to-energy simulation, while measured CSV remains preferred when available?
- Should custom report outputs be HTML/PDF first, or DOCX first for client editing?
- Should monthly compliance be the default tender test, with daily diagnostics shown as supporting evidence?
- Should BESS augmentation be allowed as an optimization variable, or only as a finance/dispatch scenario?

## 15. Immediate Next Wireframe Deliverables

Create wireframes in this order:

1. Sidebar shell and global case header.
2. Project Configuration.
3. Yield Assessment.
4. Optimization.
5. Optimizer Validation.
6. Results Dashboard.
7. Custom Dispatch.
8. Reports.
9. Finance and Financial Statements.
10. Sensitivity & Scenarios.

This order gives the fastest path to a coherent enterprise demo because it follows the real analytical workflow.
