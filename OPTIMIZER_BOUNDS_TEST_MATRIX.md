# Optimizer Search Bounds Test Matrix

Generated from `tests/test_optimizer_bounds_matrix.py` using the React API optimizer path:

```bash
python3 -m pytest -q tests/test_optimizer_bounds_matrix.py --import-mode=importlib
```

The matrix validates that editable optimizer bounds are honored, contracted capacity is rounded/selected correctly, HiGHS is used for the LP seed, the greedy coordinate-descent refinement always runs (including Fast effort), and financial outputs remain logical.

> Note: the table below was regenerated after the optimizer search fix (always-on greedy
> refinement, live random exploration, cost-aware bid-scaled candidate grid) in an
> environment **without** the `Wind Generation Bikaner.csv` P50 profile, i.e. on the
> synthetic wind trace. With the measured wind profile available, absolute tariffs are
> lower, but the structural and directional assertions are profile-independent.
> Re-run the command above locally to regenerate machine-specific numbers.

| Scenario | Search Bounds Summary | Expected | Solar MW | Wind MW | BESS MW | BESS MWh | Contracted MW | Tariff Rs/kWh | Equity IRR | Min DSCR | Min Peak Availability | Penalty GWh | Result |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| baseline_editable_bounds | Solar 225-450, Wind 15.75-63, BESS 0-277.5 MW / 0-1110 MWh, CC 150-250 | Feasible | 225.0 | 35.1 | 120.8 | 594.0 | 150 | 6.95 | 14.00% | 1.49x | 90.1% | 0.0 | Pass |
| fixed_cc_150 | Solar 180-360, Wind 10-70, BESS 0-230 MW / 0-900 MWh, CC fixed 150 | Feasible | 225.0 | 34.5 | 125.5 | 594.0 | 150 | 6.97 | 14.00% | 1.49x | 92.0% | 0.0 | Pass |
| fixed_cc_180 | Solar 225-420, Wind 15.75-80, BESS 0-250 MW / 0-1000 MWh, CC fixed 180 | Feasible | 270.0 | 35.4 | 153.2 | 712.8 | 180 | 6.87 | 14.00% | 1.50x | 91.7% | 0.0 | Pass |
| fixed_cc_220 | Solar 300-520, Wind 25-90, BESS 0-320 MW / 0-1280 MWh, CC fixed 220 | Feasible | 300.0 | 38.8 | 185.8 | 871.2 | 220 | 7.06 | 14.00% | 1.50x | 90.3% | 0.0 | Pass |
| wind_heavy_bounds | Solar 250-380, Wind 50-140, BESS 0-280 MW / 0-1100 MWh, CC 180-240 | Feasible | 263.5 | 50.0 | 150.2 | 712.8 | 180 | 6.85 | 14.00% | 1.49x | 92.4% | 0.0 | Pass |
| storage_constrained_stress | Solar 300-520, Wind 25-90, BESS 0-140 MW / 0-420 MWh, CC 200-220 | Infeasible | 520.0 | 90.0 | 140.0 | 420.0 | 200 | Infeasible | N/A | N/A | 67.2% | 488.1 | Pass |

## Core Assertions

- Every optimized capacity must stay inside the scenario bounds.
- Optimizer metadata must report `scipy.optimize.linprog(method='highs')`.
- Feasible cases must return `status.reason == "ok"`, finite tariff, zero penalty energy, equity IRR at 14%, and DSCR above 1.10x.
- The storage-constrained case must fail hard compliance with a monthly peak availability shortfall.
- The optimizer history must contain greedy coordinate-descent (`polish_round`) evaluations in every scenario, including Fast effort (regression check for the bug where a raw seed-grid candidate — solar = 2.0x bid, wind = 1.0x bid, BESS = 0.9x bid / 4 h — was returned unrefined as the "optimum").
- Directional checks:
  - Larger fixed bids buy strictly larger projects (total project cost ordering 220 > 180 > 150). Per-kWh tariff ordering across different bounds sets is intentionally *not* asserted: fixed opex and lump-sum costs dilute over a larger bid, so a better-optimized 180 MW case can legitimately price below 150 MW.
  - Tariffs of the fixed-bid cases sit within Rs 1.0/kWh of each other.
  - Fixed 150 MW uses less BESS power than fixed 220 MW.
  - Wind-heavy bounds select more wind than the baseline.
