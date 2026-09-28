# FDRE Optimizer — User Manual

The FDRE Optimizer is a Streamlit application for screening and sizing a Wind + Solar + BESS portfolio against the NHPC FDRE Tranche-II tender (1200 MW Firm & Dispatchable RE, Tender ID 2024_NHPC_800202_1). It simulates hourly dispatch across the 25-year PPA, tests the tender's compliance conditions (90% monthly peak availability, declared-CUF band), runs a 25-year post-tax financial model, and answers the bid question: **what is the minimum tariff at which this portfolio meets the target equity IRR and DSCR?** A capacity optimizer searches wind/solar/BESS/contracted-capacity sizing to minimise that tariff.

## 1. Installation and launch

```bash
cd FDRE_Optimizer
python3 -m pip install -r requirements.txt
python3 -m streamlit run app.py
```

The app opens at http://localhost:8501. Requirements: Python 3.10+, streamlit, numpy, pandas, scipy, plotly.

## 2. Inputs (sidebar)

**Project JSON (optional upload).** The app starts from the bundled Rajasthan configuration (`project_config_fdre2.json`). You can upload any JSON exported from the app ("Download current project JSON" in the Project tab). The JSON schema requires `nodes`, `generators`, and `bess` sections.

**Tender / offtake.** Contracted capacity (MW), declared annual CUF (min 40% per RfS), peak schedule mode, and two compliance switches: "Require zero modeled penalty MWh" (hard compliance — the tariff solver refuses any configuration with modelled penalties) and "Allow up to 5% external green support" (the RfS Cl. 6.1(m) option to buy green energy to cure shortfalls; you set its price). Peak schedule modes: *fixed* uses set hours (default 07, 08, 19, 20); *worst_deficit_daily* stress-tests by letting the buyer pick the two worst hours in each RfS window every day.

**Resource assumptions.** Per-generator CUF and degradation, weather seed, and variability parameters for the synthetic hourly profiles. Replace synthetic profiles with measured 8760-hour traces (via the JSON/model layer) before any investment-grade use.

**Finance.** Target equity IRR, minimum DSCR, debt fraction, interest rate, tenor, lump-sum costs (land, transmission, owner's costs), contingency, merchant price and escalation.

**Capex unit rates.** Default and per-asset EPC rates for solar (₹cr/MWac), wind (₹cr/MW), BESS energy (₹cr/MWh) and PCS (₹cr/MW).

**Operating solve mode.** *Fast representative years* simulates years 1, 5, 10, 15, 20, 25 and interpolates the rest (interactive use). *Exact full PPA term* simulates all 25 years (audit-quality; use this before quoting numbers externally).

## 3. Tabs

**Optimizer.** Set bounds for wind MW, solar MW, BESS power/energy, contracted capacity, choose Effort, and click "Run optimizer and full 25-year PPA solve". The engine seeds the search with a HiGHS linear program (lowest proxy-capex point clearing annual-energy, peak-power and BESS-duration constraints), evaluates candidates through full dispatch + finance, then re-solves the winner over the exact 25-year term. Results show optimized sizing, required gross tariff, and tender checks. Note: at Fast effort only ~8 candidates are evaluated — treat the result as a screening estimate and re-run at Thorough for anything decision-grade.

**Compliance dashboard.** Validates the optimized result year by year: monthly peak availability vs the 90% floor, annual CUF vs the declared band, penalty energy, and the tender checklist (bid-size limits, 10 MW multiple, CUF ≥ 40%, RE-only charging and so on).

**Finance.** Keeps the optimized MW/MWh sizing fixed and lets you vary financing assumptions (interest rate, debt fraction, DSCR floor, target IRR, tenor, merchant price/escalation) to see tariff and returns sensitivity without re-running dispatch.

**Custom results.** Evaluates whatever is currently configured in the sidebar (without optimizing) — use this to price a specific configuration or to reproduce the as-uploaded portfolio. If the case is infeasible under hard compliance, the tab explains why and offers to price it with penalties anyway at a reference tariff.

**Project.** The current configuration in detail, plus JSON/CSV downloads of the configuration, operating summary, first-year hourly dispatch and finance table.

**Dispatch.** Hourly dispatch charts for any year and any window (generation by asset, PPA peak/non-peak supply, BESS charge/discharge, SOC, merchant, spill).

**Exports.** Full-PPA-term audit files: hourly dispatch for every year (219,000 rows), yearly dispatch/compliance, monthly compliance, and the exact configuration JSON used.

## 4. Reading the outputs

**Required gross tariff (₹/kWh):** the minimum tariff at which equity IRR ≥ target *and* min DSCR ≥ floor. "Gross" means before the ₹0.02/kWh PSM charge, which the model nets out of PPA revenue internally. Whichever constraint binds (often DSCR) determines the tariff; the achieved IRR may therefore exceed the target slightly.

**Peak availability / annual CUF:** compliance is judged monthly against 90% of the peak-hour obligation and annually against declared CUF −15%, with PPA energy capped at declared CUF +10%. Penalties are 1.5 × tariff on shortfall energy — but by default the solver requires zero penalties (hard compliance) rather than pricing them.

**IRR / DSCR / NPV:** post-tax equity IRR on phased equity outflows plus free cash flow to equity; project IRR on total cost vs CFADS; DSCR is CFADS over annuity debt service. The year-11 BESS augmentation is a large negative cash-flow year — check the NPV alongside IRR when comparing options.

## 5. Typical workflows

*Price the uploaded portfolio as-is:* leave defaults, open Custom Results. (Note: the as-uploaded Rajasthan portfolio is infeasible in degraded-BESS years — see Troubleshooting.)

*Find a feasible, cheapest configuration:* set bounds around your realistic build-out, Effort = Thorough, run the Optimizer, then confirm in the Compliance dashboard and re-solve in Exact mode.

*Bid-tariff sensitivity to financing:* run the Optimizer once, then use the Finance tab to vary debt terms and merchant assumptions with sizing locked.

*Audit hand-off:* Exports tab → full hourly + yearly + monthly files + config JSON.

## 6. Troubleshooting

**"Custom required tariff: Infeasible" / NaN.** The configuration breaches a hard compliance test in at least one simulated year. The three practical levers, in rough order of cost-effectiveness: enable 5% external green support (RfS-permitted; cures modest shortfalls cheaply), reduce contracted capacity, or increase BESS energy/power. You can also untick hard compliance to price the case with 1.5× penalties instead. For the bundled portfolio: green support → ₹5.58/kWh, CC 180 MW → ₹5.62/kWh, BESS +30%/+15% → ₹6.19/kWh.

**Optimizer result looks beatable.** Increase Effort (Fast evaluates very few candidates) and widen bounds; the optimizer rounds contracted capacity to 10 MW multiples per the RfS.

**Changed the augmentation year but nothing improved.** Physical capacity recovery comes from the BESS SOH curve (reset year baked into the curve), while the finance schedule only controls capex. Keep both aligned — the app now warns when they differ.

**Slow interactions.** Use Fast representative-years mode while exploring; Exact mode re-simulates all 25 years. The full hourly export is intentionally heavy.

**Results change with the seed.** Synthetic profiles are stochastic; fix the seed for comparability, and test a few seeds before relying on a marginal compliance pass (a case passing at 90.0–91% availability may fail on a different weather draw).

## 7. Limitations

Synthetic resource profiles calibrated to CUF, not measured data; single-point merchant price with haircut rather than market price curves; buyer assumed to schedule the full contracted capacity in all non-peak hours (take fraction configurable); no intra-day re-optimization of the peak schedule against prices; screening-grade — not a substitute for bankable resource assessment, lender model audit or legal review.
