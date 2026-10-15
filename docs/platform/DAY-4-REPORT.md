# Day 4 report: MILP and both economic workflows

Date: 2026-10-15. Branch `claude/laughing-pascal-7akw12` in `Ergplan/FDRE`. Formulation and certification boundary: `docs/platform/FORMULATION.md`.

## Gate

| Gate requirement | Evidence |
|---|---|
| Analytical fixtures verify energy balance, SOC, ramps and economics | `tests/platform/test_milp.py` (6 fixtures): RE balance and contracted-capacity cap with the exact objective value computed by hand; BESS shifting solar into the evening peak with the efficiency-adjusted circular SOC recursion checked hour by hour and RE-only charging; thermal commitment with minimum stable generation, ramps, start-up and minimum up/down times; market purchases bounded by the external sourcing allowance including delivery loss; a tampered dispatch caught by the certifier. Every fixture is certified by `optimization/certify.py`, which recomputes the physics and the objective from the exported decisions and never reads solver residuals. |
| Feasible, infeasible and time-limited cases classified | `test_milp.py::test_infeasible_and_time_limited_cases_are_classified` and `tests/platform/test_economic_workflows.py`: a run with no admissible charging source and an auxiliary load is `infeasible` (solver `kInfeasible`, no finance); a run stopped by the time limit is `time_limited` with gap and bound and its incumbent still certified; cancellation is a separate status. |
| Fixed-tariff evaluation does not change capacities silently | `test_fixed_tariff_milp_holds_capacities_and_reports_finance`: the scenario revision and the generator list are unchanged after the run, the snapshot carries the inputs hash and `capacities_fixed: true`; dispatch optimisation is an explicit option (`dispatch = milp` or `rules`, `test_fixed_tariff_rules_dispatch_is_an_explicit_choice`); capacity optimisation stays a separate legacy run kind. |

## What was built (changed files)

- `fdre_platform/optimization/spec.py`: the immutable dispatch specification (RE units with loss-chain and degradation adjusted availability, thermal units with fuel costs from heat rate/calorific value/price, BESS with efficiencies, aux, throughput and cycle limits and charging sources, market purchase/sale with price scenarios, obligations from the tender rules) built from scenario inputs; fingerprinted into run snapshots.
- `fdre_platform/optimization/model.py`: the fixed-tariff MILP on HiGHS (`highspy` 1.15.1) built as sparse arrays: chronological balance, capacity bounds, interconnection import/export, SOC continuity over the whole circular year with charge/discharge efficiencies and auxiliary load, unit commitment with binaries, minimum stable generation, ramps, minimum up/down times, start-up and shut-down costs, fuel energy cap, piecewise cost segments, monthly peak availability in energy terms and the annual CUF band with shortfall variables priced at the penalty multiple, external sourcing allowance, non-peak take fraction, RE-only charging by construction of the sources, RE attribution of storage in the aggregates, curtailment and merchant surplus. Status classification: optimal / feasible_time_limit / time_limit_no_solution / infeasible / unbounded / cancelled / failed, with objective, bound and gap.
- `fdre_platform/optimization/certify.py`: independent full-resolution certifier (pattern from Replanner's `certify.py`).
- `fdre_platform/finance/model.py` (`finance.v1`): construction with IDC on drawdowns (circularity iterated), capex with contingency, fees, DSRA, debt (annuity, equal principal or DSCR-sculpted) with interest/tax circularity iterated, working capital, WDV tax depreciation with loss carry-forward and SLM book depreciation, revenue, penalties, purchases, fuel, opex escalation, augmentation, terminal value; project and equity cash flows, IRR with all roots and sign-change count, XIRR, NPV, DSCR; assumptions carry sources and defaults are marked `defaulted`.
- `fdre_platform/optimization/search.py`: contract-term runs (fast years, explicit screening years, or exact), interpolation labelled per year, the outer tariff search (sampling, monotonicity check, dispatch-invariance shortcut, bisection or grid fallback, infeasible and time-limited handling, certification boundary text), fixed-tariff evaluation and one-at-a-time sensitivities.
- `fdre_platform/worker/runs_milp.py` and worker wiring: run kinds `bid_tariff` (workflow A), `fixed_tariff` (workflow B, `dispatch = milp | rules`) and `milp_dispatch`; results JSON-clean with finance statement, term table, solver log, certification, binding diagnostics, sensitivities and the assumptions with sources.
- UI: launch buttons in the workspace bar (evaluate at tariff, optimise bid tariff), `RunResultPanel.jsx` and the "Run Results" tab.
- `tools/benchmark_milp.py`, `docs/platform/benchmark-milp.json`, `tools/demo_day4.sh`, `tools/restart_dev.sh`.

## Benchmark (declared realistic case, this container: 4 vCPU, 15 GB)

| Case | Variables | Constraints | Binaries | Status | Wall s | Gap | Peak RSS MB | Certified |
|---|---|---|---|---|---|---|---|---|
| A: 300 MWac solar + 60 MW wind + 185 MW/700 MWh BESS, 200 MW contracted, 8,760 h | 131,413 | 79,219 | 0 | optimal | 3.1 | 0 | 298 | certified |
| B: A + 50 MW biomass unit with commitment + IEX purchase at 4.5 ₹/kWh | 201,493 | 166,816 | 8,760 | optimal | 20.9 | 0 | 641 | certified |

Screening (`fast` years or an explicit `solve_years` list) and full-resolution results are labelled per year in every result; the certifier runs on the first and last solved years.

## Tests executed and results

| Suite | Command | Result |
|---|---|---|
| Platform (Days 1-4) | `make test-platform` | 52 passed, 1 skipped (live tender_engine) in 127 s |
| MILP fixtures | `pytest tests/platform/test_milp.py` | 6 passed |
| finance.v1 | `pytest tests/platform/test_finance.py` | 5 passed (closed-form annuity IRR, sculpted DSCR, multiple roots, XIRR, cost effects) |
| Workflows through the API and worker | `pytest tests/platform/test_economic_workflows.py` | 5 passed |
| Lint and format | `ruff check`, `ruff format --check` | clean |
| Web build | `npm run build` | built |

## Reproducible demonstration

`tools/demo_day4.sh` against the running stack (2026-10-15):

```
== workflow B: fixed tariff 4.20 INR/kWh, capacities fixed, MILP dispatch
run 749663b4 succeeded | equity IRR -0.155 | project IRR 0.027 | min DSCR 0.070 | certified certified | years solved [1, 10, 25] | year-1 PPA 578.6 GWh CUF 0.440 peak_ok True
== workflow A: bid tariff search (target equity IRR 14%, min DSCR 1.10)
run d254028a succeeded search found | tariff 8.4258 | equity IRR 0.1400 | min DSCR 1.100 | monotone True invariant False | MILP solves 39 | samples 14
  tariff 2.0000 IRR -0.3106 meets False ... tariff 8.4062 IRR 0.1395 meets False | tariff 8.4258 IRR 0.1400 meets True
```

The tariff level reflects the defaulted capex and finance assumptions of the legacy project (labelled `defaulted` in the result) and a portfolio sized for a 150 MW contract; it is the output of the method, not a market statement.

## Formulation, certification boundary and limitations

- Nonlinear financial relationships are kept outside the MILP: the tariff is fixed per subproblem, so revenue is linear; IRR, taxes, DSCR-sculpted debt and working-capital circularities are evaluated deterministically by `finance.v1`; the outer search is a bisection validated by a monotonicity check at sampled points with a grid fallback. A MILP gap certifies a subproblem's dispatch; it does not certify global optimality of the outer search, and every bid-tariff result carries that sentence.
- Inter-period storage continuity is kept by solving the whole year chronologically with a circular SOC; representative periods are not used. Years not solved in `fast` mode are interpolated and labelled.
- Not yet modelled: time-varying availability calendars, BESS cycle-depth degradation inside the dispatch (calendar SOH only), multiple nodes with separate interconnection limits (one POI limit), RE share constraints across storage round trips (attribution is reported, not constrained), exchange sale limits per day.
- Thermal capex is not in the legacy project; a module `capex_cr_per_mw` is required and the assumption list flags it `MISSING` when absent.
- The dispatch-invariance shortcut compares aggregates at the two bounds and the midpoint; a dispatch that changes only inside the range would be missed, in which case bisection on finance alone would still be reported as `found` with `dispatch_invariant: true`. Day 7 adds a confirmation solve at the found tariff.
- The sample list can contain one duplicated tariff (the midpoint is sampled for the monotonicity check and again as the first bisection step).

## Next: Day 5 concrete work

1. Formula-based Excel model (openpyxl): Read Me/provenance, assumptions, capacity/energy/losses, capex and funding, revenue/opex/market settlement, debt/depreciation/tax/working capital, cash flows, IRR/XIRR/NPV/DSCR, sensitivities, reconciliation; input/formula styling, named ranges; imported dispatch marked as a fixed run snapshot; recalculation with LibreOffice headless and comparison with `finance.v1`; a test that changing an input changes dependent outputs.
2. Historical tenders from RE-tender-results: ingestion with stable keys, units and sources, comparable filters with explanations, freshness and gaps.
3. Collaboration: tender chat, threaded comments, mentions, tasks, review decisions, activity; concurrent-edit tests.
