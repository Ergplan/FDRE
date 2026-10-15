# Dispatch formulation, tariff search and certification boundary

Version `milp.v1` (`fdre_platform/optimization/`), finance `finance.v1` (`fdre_platform/finance/`).

## 1. Sets and data

- Intervals t = 0..T−1 of length Δ hours (T = 8760 hourly, or 35,040 at 15 minutes); month m(t); peak set P (intervals inside the tender's peak windows).
- RE units g with available power A_g,t (MW at the POI: profile × capacity × loss-chain multiplier × availability × evacuation × degradation of the year).
- Thermal/biomass units u: P̄_u, P_u (minimum stable), ramps R⁺_u, R⁻_u (MW per interval), minimum up/down times U_u, D_u (intervals), start-up and shut-down costs, variable cost c_u (fuel from heat rate, calorific value and price, plus VOM), optional piecewise segments, availability and auxiliary fraction (applied to P̄ and P), annual fuel energy cap F_u.
- BESS units b: power rating, charge/discharge limits, usable energy E_b, efficiencies η⁺_b, η⁻_b, auxiliary load, availability, throughput and cycles-per-day limits, allowed charging sources.
- Market: purchase limit, daily MWh limit, purchase price π⁺_t and charges, sale limit and sale price π⁻_t and charges, delivery loss λ; merchant fallback price when no exchange sale is configured.
- Obligations: contracted capacity C, peak availability floor α, CUF floor/cap κ⁻/κ⁺ on hours H (8766 convention), penalty multiple ρ, external sourcing share ε, non-peak take fraction, PSM charge.

## 2. Variables

Per RE unit: ppa, sell, curtail, charge (to RE-chargeable storage). Per thermal unit: p (net MW), on ∈ {0,1}, start, stop ∈ [0,1], ppa, sell, charge (when grid charging is allowed), segment outputs. Per BESS: ch, dis, soc, dis_ppa, dis_sell, ch_market. Market: buy, buy_ppa. Totals: D_t (delivered to the PPA), S_t (sold). Shortfalls: s_m (monthly peak), s_a (annual).

## 3. Constraints

1. RE balance: ppa + sell + curtail + charge = A_g,t.
2. Thermal: p − ppa − sell − charge = 0; P_u·on ≤ p ≤ P̄_u·on; on_t − on_{t−1} = start_t − stop_t; p_t − p_{t−1} ≤ R⁺ + P̄·start_t; p_{t−1} − p_t ≤ R⁻ + P̄·stop_t; Σ_{k=t−U+1..t} start_k ≤ on_t; Σ_{k=t−D+1..t} stop_k ≤ 1 − on_t; Σ p·Δ ≤ F_u; p = Σ segments with segment widths.
3. BESS: ch = Σ allowed sources (RE charge, thermal charge, market charge); dis = dis_ppa + dis_sell; soc_t = soc_{t−1} + η⁺·ch·Δ − dis·Δ/η⁻ − aux·Δ, circular over the year (t = 0 links to T−1, so no end-of-horizon dumping); ch + dis ≤ rating; soc ≤ E_b; throughput and daily cycle caps.
4. Market: buy·(1−λ) = buy_ppa + ch_market; limits per interval and per day.
5. Delivered and sold: D_t = Σ ppa + Σ dis_ppa + buy_ppa; S_t = Σ sell + Σ dis_sell; D_t ≤ C (× take fraction outside peaks); D_t + S_t ≤ interconnection; buy_t ≤ interconnection.
6. Obligations: Σ_{t∈P∩m} D_t·Δ + s_m ≥ α·C·|P∩m|·Δ; Σ D·Δ + s_a ≥ κ⁻·C·H; Σ D·Δ ≤ κ⁺·C·H; Σ buy_ppa·Δ ≤ ε·Σ D·Δ; when a minimum RE share applies, Σ non-renewable ppa·Δ ≤ (1−share)·Σ D·Δ.

## 4. Objective (fixed tariff τ)

min −(τ − PSM)·1000·Σ D·Δ − Σ (π⁻_t − charges)·1000·S_t·Δ + Σ (π⁺_t + charges)·1000·buy_t·Δ + Σ c_u·p·Δ + Σ start/stop costs + ρ·τ·1000·(Σ s_m + s_a).

The tariff is a constant inside each subproblem, so revenue is linear. Bilinear tariff × energy terms never appear inside the MILP.

## 5. Certification

`certify.certify` recomputes every constraint family and the objective from the exported decisions with independent code (no solver residuals): RE balance, thermal bounds, split, binary integrality, ramps, logic, minimum up/down runs, fuel cap, BESS limits, SOC recursion, RE-only charging, throughput, market split, delivered/sold definitions, contracted capacity, interconnection, monthly peak energy, annual band, external share, and the objective to 1 INR / 1e-6 relative. A run whose certification fails is reported as failed validation whatever the solver said.

## 6. Outer tariff search (workflow A)

The equity IRR is not a linear function of the tariff, and taxes, DSCR-sculpted debt and working capital form circularities inside the financial evaluator. The platform therefore keeps the MILP linear at a fixed tariff and searches the tariff outside:

1. Sample the tariff at the bounds and the midpoint; solve the MILP at each; evaluate finance (`finance.v1`) on the dispatch aggregates.
2. Monotonicity check: equity IRR must be non-decreasing in the tariff across the samples (within 1e-6). If dispatch aggregates are identical at the bounds, the dispatch is tariff-invariant on the range and the search runs on the financial evaluator alone (no further MILP solves). If aggregates differ and IRR is monotone, bisection with a MILP solve per step. If IRR is not monotone, the search falls back to a grid over the range and reports the smallest tariff that meets the target, marked `non_monotone`.
3. Infeasible subproblems stop the search with `infeasible`; a time-limited subproblem carries its gap into the result and the outcome is marked `time_limited` (the tariff found is an upper bound on the required tariff only if the incumbent's dispatch is feasible, which the certifier confirms).
4. Target: equity IRR ≥ target and minimum DSCR ≥ floor at the tariff; tolerance 0.005 INR/kWh.

Certification boundary: the MILP gap certifies the dispatch of each subproblem at its tariff; the outer result is the smallest sampled tariff meeting the financial target under the monotonicity verified at the sampled points. It is not a global optimality certificate of a nonlinear problem, and the report says so on every bid-tariff run.

## 7. Multi-year treatment and resolution

The year is solved whole, chronologically, with circular storage continuity. For the contract term, years 1, 5, 10, 15, 20 and 25 (degraded profiles, SOH, escalated fuel and market prices) are solved and the annual aggregates of the years between are interpolated (`years_mode = fast`), or every year is solved (`exact`). Results are labelled with the years actually solved. Final candidates are validated at the tender's required resolution: the certifier runs on the full-resolution year 1 and final year dispatches before a run is reported `succeeded`.

## 8. Workflow B (fixed tariff investment evaluation)

The tariff and the capacities are held fixed. Dispatch is either rule-based (the legacy chronological engine, `dispatch = rules`) or optimised (`dispatch = milp`) when selected; the finance evaluator then reports equity IRR, project IRR, NPV, DSCR and the sensitivities. Capacity optimisation is a separate run kind (`capacity_search`, the legacy screening search) and is never run silently.
