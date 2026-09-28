# QA & Tender-Compliance Test Report — FDRE Optimizer

**Application:** Enterprise FDRE Optimization Engine (Streamlit app + `fdre_enterprise_engine.py`)
**Tender reference:** NHPC FDRE Tranche-II, 1200 MW Firm & Dispatchable RE + ESS, Tender ID 2024_NHPC_800202_1 (`RFS.pdf`, 264 pp)
**Project reference:** `PROJECT CONFIGURATION_FDRE 2.docx` (Rajasthan portfolio: 31.5 MW wind, 300 MWac solar, 185 MW / 740 MWh BESS across Fatehgarh 4S2, Bikaner III, Bikaner II)
**Test date:** 8 July 2026 · **Files as of:** 8 July 2026

## Verdict

**Shippable as an internal bid-screening and sizing tool, with two product decisions to close (F1, F2 below).** The engine's mathematics were verified independently and are correct: all 30 external validation checks passed, all 16 team tests pass, the app UI ran without a single exception across default and optimizer flows, and the NHPC tender conditions are faithfully encoded with correct clause-level parameters. One protective fix was applied during this review (F3). The tool is not — and does not claim to be — a substitute for bankable resource assessment or a lender-grade model.

## Scope and method

The review covered static code review of the engine (1,639 lines) and app (750 lines) against the RfS text; execution of the team's pytest suite; an independent 30-check numerical battery that recomputes dispatch invariants and every finance line item from scratch; UI execution via Streamlit AppTest including the optimizer button flow; and a cross-check of the fast (representative-year) solve against the exact 25-year solve.

## Tender-condition verification matrix

| # | RfS provision | Clause | Implementation | Result |
|---|---|---|---|---|
| 1 | Min 90% availability of contracted capacity during peak hours, tested monthly | 6.1(a), 6.2(a) | Monthly floor = 90% × peak-hour obligation; shortfall energy penalised | PASS |
| 2 | Peak hours: 2 morning within 05:00–10:00 + 2 evening within 18:00–23:00, buyer-scheduled | 6.1(f) | Default fixed hours {7, 8, 19, 20}; both windows enforced; `worst_deficit_daily` stress mode picks the 2 worst hours per window daily | PASS |
| 3 | Declared annual CUF ≥ 40%; maintain within +10% / −15% of declared | 6.1(b) | Floor = 0.85 × declared (LD below), PPA energy cap = 1.10 × declared | PASS |
| 4 | Annual CUF on 8,766-hour convention, Apr–Mar contract year | 6.1(e) | `cuf_hours_per_year = 8766` (dispatch simulates 8,760 h; disclosed convention) | PASS |
| 5 | LD = 1.5 × tariff on shortfall units; monthly-peak and annual-CUF damages can both apply | 6.2(c), 6.2(e) | `penalty_multiplier = 1.5`; both damages computed; green support prioritised to monthly peak first | PASS |
| 6 | Up to 5% of annual energy from green market/bilateral sources | 6.1(m) | Optional toggle, 5% cap, purchase cost modelled at user price | PASS |
| 7 | Sale of generation beyond CC / unscheduled power to third parties or exchange without NOC | Art. 4.4.5 (PPA) | Merchant revenue stream with curtailment haircut, node-limit constrained | PASS |
| 8 | ESS charged from RE only | Project scope | Charging only from same-node RE; verified by hourly invariant test | PASS |
| 9 | EMD = ₹9.28 L/MW solar + ₹12.64 L/MW wind + ₹14.64 L/MW ESS, capped ₹10 cr/project | Bid info (v) | Exact formula incl. cap (default portfolio: raw ₹58.9 cr → capped ₹10.0 cr) | PASS |
| 10 | PBG = ₹23.20 L/MW solar + ₹31.60 L/MW wind + ₹36.60 L/MW ESS | 3.11 | Exact; reproduces RfS worked example (250 MW → ₹9,965 L) | PASS |
| 11 | Processing fee slabs ₹3–30 L + GST | 3.3 | Slab function verified at boundaries | PASS |
| 12 | Success charge ₹1,00,000/MW + 18% GST before PPA | 3.13 | Included in project cost | PASS |
| 13 | PSM charge ₹0.02/kWh as discount to tariff payment | 3.13 | Netted from PPA tariff in revenue | PASS |
| 14 | 25-year PPA term | Definitions | `ppa_years = 25` throughout | PASS |
| 15 | Bid capacity limits and 10 MW multiples | Eligibility | `validate()` + optimizer rounding to 10 MW multiples | PASS |

## Independent numerical validation (30/30 passed)

Dispatch invariants on year-1 hourly output: energy balance closes to 1.1e-13 MWh; peak supply never exceeds target; non-peak PPA never exceeds contracted capacity; total export never exceeds interconnection limits (max 236.8 vs 280 MW); SOC stays within [0, usable]; BESS discharge ≤ charge × RTE + SOC swing; annual PPA ≤ 110% CUF cap; exactly 4 peak hours/day inside RfS windows; charging never exceeds available RE. Monthly availability and 90%-floor shortfall formulas reproduce exactly.

Finance cross-check at ₹4.50/kWh: revenue, opex, EBITDA rows match an independent recomputation to 1e-9 relative tolerance; annuity debt schedule matches with debt fully repaid at tenor end; equity and project IRR satisfy NPV = 0 at the reported rate; min DSCR matches the table; tax with 40% WDV block, non-eligible SLM and loss carry-forward reproduces exactly; EMD cap, PBG, processing fee, success charge and PSM netting all verified against the RfS text.

App execution: 16/16 pytest; AppTest default run with zero exceptions (the infeasible default is reported honestly as "Infeasible"); optimizer button flow completes in ~11 s with coherent optimized metrics and 9/9 tender checks; exact 25-year solve (5 s) agrees with the representative-year solve within 0.2% on required tariff (₹5.707 vs ₹5.698).

## Findings

**F1 — As-uploaded portfolio is infeasible under the tender's 90% peak-availability floor. Severity: High (product decision, not a code bug).**
BESS state-of-health degradation pushes minimum monthly peak availability to 86–87% in years 8–10 (before the year-11 augmentation) and 85.8–86.1% in years 18–25 (as the augmented battery ages, with the SOH curve flat at 82.7% beyond year 20). The engine correctly refuses to price this (`required tariff = NaN`, reason "monthly peak availability shortfall") and the app displays it transparently. Quantified cures, each restoring feasibility: enable the RfS-permitted 5% green support → ₹5.578/kWh; reduce contracted capacity to 180 MW → ₹5.619/kWh; enlarge BESS by +30% energy / +15% power → ₹6.190/kWh. *Recommendation:* decide the default posture (e.g., ship with green support enabled, a feasible default sizing, or a second augmentation) so the first-run experience is not NaN; keep the honest warning either way.

**F2 — Optimizer search coverage is thin at low effort. Severity: Medium.**
"Fast" effort evaluates only 7–8 candidates (LP seed + fixed probes) in a 5-dimensional space with no polish. In testing, a trivial one-variable manual tweak (CC = 180 MW, ₹5.619) beat the Fast optimizer's result (₹5.698). The HiGHS LP seed is a good design and the result is *valid*, just not reliably optimal. *Recommendation:* raise candidate counts (e.g., Fast ≈ 30, Balanced ≈ 80, Thorough ≈ 200, with polish on for all), or label Fast results as "screening estimate".

**F3 — Physical/financial augmentation coupling trap. Severity: Medium. Status: FIXED in this review.**
BESS capacity recovery is driven by the SOH curve (reset baked in at year 11), while augmentation capex is driven independently by `finance.bess_augmentation_schedule`. Editing one without the other silently diverges physics from cash flows (demonstrated: moving the finance schedule to years 8+16 changed capex but not delivered energy). *Fix applied:* `ProjectConfig.validate()` now warns when BESS-spec augmentation years differ from the finance schedule; the app already surfaces validate() warnings in the sidebar. All 16 team tests re-run and pass after the patch.

**F4 — IRR uniqueness not guaranteed. Severity: Medium (disclosure).**
The year-11 full augmentation (₹555 cr, 100% of 740 MWh at ₹0.75 cr/MWh) makes equity cash flow negative mid-term, producing 3 sign changes; multiple IRR roots are mathematically possible. NPV = 0 was verified at the reported root in all tested cases. *Recommendation:* display the equity NPV alongside IRR (already computed) and consider an NPV-vs-discount-rate chart or MIRR for audit contexts.

**F5 — Low-severity notes.** (a) Dispatch simulates 8,760 hours while CUF obligations use the RfS 8,766-hour convention — deliberate and documented (≈0.07% conservatism). (b) `npv()` discounts the first construction outflow at t = 0 — internally consistent. (c) Representative-year interpolation can smooth over a penalty year between snapshots; the "Exact full PPA term" mode exists for final numbers — use it before quoting. (d) In `worst_deficit_daily` mode, year-1 availability sits exactly at 90.0% — knife-edge; treat as stress case. (e) The project docx itself is internally inconsistent on Bikaner III BESS (summary table 540 MWh vs BESS spec 600 MWh nameplate); the config carries the summary-table values and notes the discrepancy.

## Changes made during this review

One patch to `fdre_enterprise_engine.py`: augmentation-consistency warning added to `ProjectConfig.validate()` (warning only; no behavioural change to dispatch or finance). Test suite re-run: 16/16 pass. No other files modified.

## Reproduction

The independent validation battery is a standalone script (30 checks; available on request / from the review session). Key one-liners: `python3 -m pytest tests/ -q`; `python3 fdre_enterprise_engine.py` (prints default-case capacity summary, compliance status and required tariff).
