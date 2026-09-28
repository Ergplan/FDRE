# Model Validation And Acceptance

This is the release test plan. The prototype's existing tests are a starting
point; passing them is not certification for a new tender family.

## 1. Verification Layers

| Layer | What it proves | Owner |
|---|---|---|
| Typed inputs | Units, ranges, calendar and references valid | Backend + modeller |
| Source fixtures | Extracted facts and amendments match supplied versions | Reviewer + QA |
| Physical invariants | Dispatch conserves energy and respects equipment limits | Energy modeller |
| Rule tests | Correct period, denominator, tolerance and exceptions | Tender modeller |
| Settlement tests | Eligible volumes, market/PPA cash flows and penalties reconcile | Finance modeller |
| Finance golden model | Independent statements, IRR, debt and working capital agree | Finance modeller |
| Search challenge | Winner compared consistently with alternatives | Optimization modeller |
| End-to-end | UI inputs reach engine; approvals/versioning/export work | QA |
| Operational | Tenant isolation, job recovery, permissions and reproducibility | Platform |

Expected values must come from hand calculations or independently maintained
fixtures, not from the same function under test. Store fixture input hashes,
expected outputs, tolerances, reviewer identity and approval date.

## 2. Physical Equations And Tests

For each interval of length `dt` hours and a defined common electrical boundary:

```text
available renewable energy + permitted imports + battery discharge
  = contract export + merchant export + battery charge + spill + accounted losses

SOC[t+1] = SOC[t] * retention(dt)
           + eta_charge[t] * charge_MW[t] * dt
           - discharge_MW[t] * dt / eta_discharge[t]

SOC_min[t] <= SOC[t] <= usable_energy_capacity[t]
charge_MW[t] <= available_charge_power[t]
discharge_MW[t] <= available_discharge_power[t]
```

If generation is already net at the common boundary, do not deduct those losses
again. Track internal and PoI flows separately where efficiencies require it.
Do not permit simultaneous charging/discharging without an explicitly justified
formulation; use binary exclusivity if the relaxation cannot guarantee it.

| Test | Input | Expected invariant/result |
|---|---|---|
| PHY-01 | 1 MW for one 15-minute interval | 0.25 MWh |
| PHY-02 | Empty storage, zero generation/imports | No positive delivery from invented initial SOC |
| PHY-03 | Charging/discharging and loss traces | Interval balance residual within declared tolerance |
| PHY-04 | Morning/evening split peaks, midday solar | SOC may recharge between peaks; duration not automatically four continuous hours |
| PHY-05 | Two-hour toggle and power bound 80 MW | Energy exactly 160 MWh or contradiction rejected |
| PHY-06 | End-of-peak SOC remains high | Explain binding export/obligation/reserve limits; residual SOC alone does not prove oversizing |
| PHY-07 | Year-boundary SOC | No free-energy reset; approved terminal/cyclic policy enforced |
| PHY-08 | Augmentation adds a cohort | Existing cohorts retain own age/SoH; no reset of whole battery fleet |
| PHY-09 | Grid limit below combined generation | Export capped, excess explicitly stored/curtailed/spilled |
| PHY-10 | Zero asset or disabled technology | No capacity, energy or recurring technology cost from that asset |
| PHY-11 | Per-site solar profiles | Site capacity times normalized CF matches site generation |
| PHY-12 | Wind integer-count mode | Capacity is turbine rating x integer count; candidates obey bounds |

For annual simulation, distinguish weather-year reuse from actual chronological
multi-year data. A full-term run may repeat a reference weather year with ageing;
label it explicitly. Calendar expansion and degradation are not evidence of 25
independent years of weather uncertainty.

## 3. Compliance And CfD Golden Cases

| Test | Case | Expected outcome |
|---|---|---|
| RUL-01 | Declared CUF 40%, lower tolerance 15% relative | Lower bound 34%, not 25% |
| RUL-02 | Declared CUF 40%, upper multiplier 1.10 | Upper band 44%; eligible excess-energy policy tested separately |
| RUL-03 | Monthly energy availability at threshold | Pass/fail from unrounded values and defined tolerance |
| RUL-04 | CfD 100 MW, two hours/day | Daily obligation 200 MWh; seven-day obligation 1,400 MWh |
| RUL-05 | CfD weekly 10% shortfall allowance | 1,260 MWh threshold before approved exclusions; below this computes penalizable deficit |
| RUL-06 | Monthly surplus but one deficient contract week | Deficient week remains visible and cannot be netted away without an explicit rule |
| RUL-07 | Eight selected 15-minute blocks | Exactly two hours; selected blocks within approved non-solar/clock limits |
| RUL-08 | Market volume offered but not cleared | No eligible settlement on uncleared volume |
| RUL-09 | Daily delivery above eligible cap | Excess does not offset another day's capped obligation |
| RUL-10 | External green above 25% approved annual basis | Excess excluded/treated according to rule; charge energy not counted as discharged green supply |
| RUL-11 | Allowed curtailment | Obligation adjustment only once, with reason/evidence and interval ledger |
| RUL-12 | Amendment upload | Prior rule version unchanged; conflict remains blocked until reviewed |
| RUL-13 | Missing annual CUF in CfD source | No inherited 40% annual CUF requirement |
| RUL-14 | 12-year contract | No years 15/20/25 simulated by an unfiltered fast-year list |
| RUL-15 | Contract starts midweek or leap year | Correct approved partial-week/calendar denominator |

CfD settlement test basis: one eligible kWh, excluding separate fees/taxes/REC
flows. Sign convention: positive settlement is cash received by RPD from pool.

| Test | SP / MCP | Expected cash components under supplied fixture |
|---|---|---|
| CFD-01 | 5.7 / 6.2 | Exchange receipt 6.2, pool payment 0.35, RPD net 5.85 |
| CFD-02 | 5.7 / 3.0 | Exchange receipt 3.0, pool receipt 0.81, RPD net 3.81 |
| CFD-03 | 5.7 / 12.0, amendment effective | Pool payment 2.29, RPD retained gain 4.01, RPD net 9.71 |
| CFD-04 | MCP exactly SP-1, SP-0.5, SP+1.5, SP+3, 10 | Correct inclusive/exclusive slab boundary; no overlap or gap |
| CFD-05 | Weekly reference MCP below SP | Penalty floor follows source rule; do not create negative penalty income |
| CFD-06 | No eligible cleared energy | No CfD settlement; unrelated merchant receipts remain separate |

Add controls for amendment effective dates, whole-slab versus incremental sharing,
REC pool payments, contract administration charges and third-party sale penalties.
Monthly settlement is a sum of interval/weekly ledgers, not a formula applied to
the monthly average MCP.

## 4. Financial Reconciliation

| Test | Perturbation | Expected result |
|---|---|---|
| FIN-01 | Debt fraction zero and no other borrowing facilities | Debt draw, interest and principal zero; DSCR N/A; project/equity cash flows equal when no equity-specific costs differ |
| FIN-02 | Same operations, tariff and debt draw with debt resizing disabled; higher debt interest | Interest line rises; effects reconcile through taxes/debt/equity, no automatic tariff reset in fixed-price mode |
| FIN-03 | Required-price mode, fixed design | Price may rise to clear target return; changing price is disclosed |
| FIN-04 | No leverage, simple two-period fixture | Initial equity investment included once at time zero; independently computed IRR/NPV |
| FIN-05 | Debt tenor ends | Opening/closing balances roll forward and debt amortizes to zero within tolerance |
| FIN-06 | Sculpting and debt resizing | CFADS/interest/tax iteration converges or fails explicitly; actual gearing displayed |
| FIN-07 | Receivable/payable/inventory-day changes | Working-capital cash movement and financing cost reconcile; terminal release explicit |
| FIN-08 | Capacity doubled with fixed/per-unit mixed costs | Only per-unit costs scale; no unexplained fixed lump sums |
| FIN-09 | Solar/wind/BESS absent | Related land/development/opex absent unless separately justified |
| FIN-10 | Augmentation in year N | Correct year-N cash outflow, financing/tax treatment and cost-decline base |
| FIN-11 | Cash flows never change sign or change repeatedly | IRR undefined/nonunique warning; NPV retained, no arbitrary plausible IRR |
| FIN-12 | Finance-only scenario | Sizing and dispatch artifact hashes unchanged |
| FIN-13 | New optimization during scenario calculation | Late scenario response cannot overwrite new baseline |
| FIN-14 | Penalty and tax lines | Penalty counted once; tax treatment explicit and loss carry-forward verified |

Use a separate reviewed workbook or independent reference implementation for
golden cases. Workbooks in `Enterprise_Build/` are candidate references and must
first be reconciled; their presence in the repository is not validation.

## 5. Optimization Objective And Proof

For PPA families, default target is minimum required gross tariff satisfying
approved hard constraints, target equity return and financing covenants. Display
whether debt resizing was used and what actual leverage resulted.

The current search adds capex and spill penalties to tariff. During migration,
preserve that as a labelled `legacy_weighted_score` baseline. Implement pure
minimum tariff separately and compare differences. If the product wants low spill
as a secondary objective, use an explicit tie-break policy within an approved
tariff epsilon, or expose a Pareto trade-off. Do not quietly change the objective.

HiGHS may certify an LP/MIP formulation to a bound/gap. That certificate applies
only to that formulation. It does not prove global optimality of an outer nonlinear
finance/dispatch search. Report objective units, incumbent, lower bound and gap
only when they are valid for the submitted optimization problem.

Required challenge suite:

1. Known small enumeration case where all feasible designs can be evaluated.
2. Bounds hit and monotonic bound-expansion tests with identical objective/settings.
3. +/-5% and +/-10% valid perturbations, nearby grid, multiple seeds where relevant.
4. Near-miss rankings by quantitative constraint violations, separate from tariffs.
5. Full-term confirmation of the winner and strongest challengers.
6. Refinement or explicit rejection if representative-year search fails exact checks.
7. No replacement of a feasible winner with a better-scoring infeasible attempt.
8. Time limit, numerical failure, infeasibility and user cancellation differentiated.

Spillage is a diagnostic, not automatically an error. Test whether a smaller
design improves the approved objective while retaining all obligations. High SOC
must be examined jointly with charging opportunity, reserves, limits and degradation.

## 6. Regression Matrix And Recorded Columns

Baseline contract demand: 50, 100, 150, 200 and 250 MW at 14% target equity IRR.
For each run use fixed contracted capacity, then vary solar/wind availability,
tight/loose capacity bounds, forced two-hour BESS, P50/P90, debt 0/50/75%,
external green allowed/disallowed and representative/full-contract mode.
Use boundary and pairwise coverage to control cost; exhaustive small fixtures
provide correctness, production-sized cases provide regression/performance evidence.

Matrix columns: fixture/version hashes, tender adapter, bid MW, site bounds,
winning capacities, objective and score components, tariff/SP, actual gearing,
IRR, DSCR, worst period, violation quantities, spill, SOC extrema, energy residual,
solver status, gap validity, elapsed time, mode, pass/fail and reviewer note.

## 7. Application And Operational Acceptance

- API rejects unapproved/unsupported rules even if the UI button is bypassed.
- Reviewer identity is authenticated; stale revisions cannot overwrite decisions.
- Upload, extraction, amendment and finance-scenario tests run with two users.
- Tenant-isolation tests cover documents, search snippets, jobs and exports.
- Worker crash/retry creates one logical result and no duplicate published report.
- CSV/columnar interval totals reconcile to charts, annual matrices and statements.
- Export headers include units, timezone, versions and simulated/interpolated labels.
- Browser tests cover desktop/mobile, keyboard review flow, slow requests and errors.
- Offline/timeout Docling fallback is visible; no-text/partial documents cannot
  silently publish a complete set of verified tender facts.

## 8. Release Evidence

Store a release manifest containing code revision, dependency image, fixture hashes,
test results, performance measurements, known limitations and domain sign-offs.
E1 requires NHPC parity plus enterprise workflow evidence. E2 additionally requires
the source-verified CfD settlement/compliance matrix. The remaining adapters stay
disabled until their own complete evidence packages pass.
