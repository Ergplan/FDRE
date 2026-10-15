# Day 3 report: supply inputs and isometric flows

Date: 2026-10-15. Branch `claude/laughing-pascal-7akw12` in `Ergplan/FDRE`.

## Gate

| Gate requirement | Evidence |
|---|---|
| Every displayed loss maps to a model input | `LossStage.model_input` must be one of `MODEL_INPUTS` in `fdre_platform/supply/losses.py`; a stage naming anything else is rejected (`test_duplicate_and_double_counted_losses_are_rejected`). The UI prints the model input next to every stage and the reconciliation row. |
| Gross-to-net energy reconciles | `Reconciliation.closes` (gross − Σ losses = net) is asserted on every module; `test_loss_chain_reconciles_and_maps_every_stage` checks the chain against an analytic product; `test_supply_config_round_trip_and_engine_reconciliation` runs the compiled configuration through the worker and checks the engine's own first-year generation per asset against the chain's energy before the evacuation stage for solar (uploaded profile) and wind (synthetic) to 0.1%. |
| Invalid profiles rejected | Missing timezone, wrong length, duplicate intervals, missing intervals, declared/actual interval mismatch, negative values, values above capacity, MW series without a capacity (`test_profile_*`); leap years are normalised by dropping 29 February and 15-minute series are averaged to hourly, both with the content hash recorded. |
| Incompatible units rejected | A profile on `installed_mw` attached to a solar module on `mwac` is refused as incompatible units; a DC-basis solar profile is converted by the declared DC/AC capacities and the clipping stage then applies (`test_incompatible_profile_units_are_rejected_and_dc_basis_is_converted`). |
| Duplicate losses rejected | Duplicate stage keys and out-of-order boundaries fail schema validation; a stage upstream of the profile's measurement boundary that is not marked `included_in_profile` is rejected as double counting; a second availability stage is rejected. |

## What was built (changed files)

- `fdre_platform/supply/schema.py`: pydantic models for the six module kinds with units in the field names, electrical boundary and time basis on every loss stage, provenance on every value, tender eligibility slot; `default_losses(kind)` chains marked `defaulted`; `FIELD_META` binds each input to the diagram component it belongs to.
  - Solar: MWp DC, MWac, DC/AC ratio, profile with CUF basis, clipping, degradation, availability, electrical and evacuation losses.
  - Wind: installed MW, turbine rating, hub height, profile, wake, electrical, curtailment, availability.
  - Thermal and biomass: capacity, minimum stable generation (% of capacity), ramp rates (MW/min), minimum up/down time (h), start-up and shut-down cost and time, planned and forced outage (%), fuel availability (t/year), calorific value (kcal/kg), heat rate (kcal/kWh) or efficiency (%) with exactly one required, fuel price and escalation, variable and fixed O&M, auxiliary consumption, piecewise cost segments, eligibility from the tender rules.
  - BESS: MW, MWh nameplate, usable SOC window, charge/discharge limits, charge and discharge efficiencies, calendar and cycle degradation, augmentation steps, replacement year, auxiliary load, availability, warranty years/cycles, throughput and cycles-per-day limits, explicit charging sources (`re_colocated`, `re_contracted`, `grid`, `market`) and renewable attribution.
  - IEX: separate purchase and sale flows with their own price scenarios (stored price profiles), MW and MWh/day limits, charges per kWh, delivery losses and eligibility; purchases count as renewable only when flagged under the tender's rules. No price or revenue is assumed.
- `fdre_platform/supply/profiles.py`: CSV parsing (timestamped or value-only), timezone, interval, duplicate/missing/order checks, leap-day policy, 15/30/60-minute normalisation to the hourly year, basis conversion (MW, MWh per interval), physical bounds with a small clipping tolerance, content hash, statistics; `scale_to_cuf` never exceeds a capacity factor of 1.
- `fdre_platform/supply/losses.py`: sequential chain (percent multiplicative, fixed MW subtracted hour by hour, availability as one annual factor) with the reconciliation table and the validation rules above.
- `fdre_platform/supply/compile.py`: the supply configuration becomes the engine project (nodes, generators, BESS with SOH from calendar degradation, finance transmission loss from the evacuation stages) plus `custom_cf` columns named as the engine names them; thermal, biomass and IEX are reported `unsupported` by the legacy engine with the reason and kept for the Day 4 formulation.
- `fdre_platform/models/profiles.py` and migration `0003`: immutable `profile` table (hash-deduplicated per organisation, original file in object storage, normalised hourly series, statistics, validation report, provenance).
- `fdre_platform/services/supply.py` and `api/routes/supply.py`: profile upload/list/get, supply schema and module templates, validate (no persistence), save into a scenario as a new input version with the compiled project, profile hashes and compiled columns; the worker uses the compiled columns and reports first-year generation per asset.
- UI: `react_demo/src/platform/iso.js` (Replanner 2:1 primitives, origin noted) and `SupplyTab.jsx`: one vertical isometric path per module generated from its components and loss chain, flows sized by the energy leaving each stage, loss arrows at their boundary (dashed when inside the profile), inputs attached to the clicked component, profile picker with CUF basis and measurement boundary, loss-chain table with model input and provenance, energy reconciliation table, completeness and validation indicators; "Supply Modules" tab in the workspace.

## Tests executed and results

| Suite | Command | Result |
|---|---|---|
| Platform (Days 1-3) | `make test-platform` | 36 passed, 1 skipped (live tender_engine) in 80 s |
| Day 3 unit | `pytest tests/platform/test_supply.py` | 8 passed |
| Day 3 API and engine reconciliation | `pytest tests/platform/test_supply_api.py` | 2 passed (solar and wind generation reconcile with the engine to 0.1%) |
| Lint and format | `ruff check`, `ruff format --check` | clean |
| Web build | `npm run build` | built |
| Browser smoke | `tools/ui_smoke_day3.py` | 3 modules added (solar, BESS, biomass), validated, saved as input version; screenshots in `docs/platform/day3-artifacts/` |

## Reproducible demonstration

```sh
tools/restart_dev.sh                      # API and worker
CHROMIUM_PATH=... .venv/bin/python tools/ui_smoke_day3.py
# or through the API:
curl -F file=@solar.csv -F technology=solar -F capacity_basis=mwac -F capacity_mw=100 -F measured_at=inverter_ac -F timezone=Asia/Kolkata \
     -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8000/api/v1/orgs/$ORG/profiles
curl -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"supply": {...}}' http://127.0.0.1:8000/api/v1/orgs/$ORG/supply/validate
```

## Defects, blockers and limitations

- The legacy engine applies the evacuation loss as a tariff-value deduction on PPA energy, not as an energy loss; the loss chain records it on `finance.transmission_loss_percent` and the reconciliation shows it as energy. The Day 4 formulation models it as energy at the POI.
- Thermal, biomass and IEX modules are validated and reconciled but not dispatched until Day 4.
- Loss chains are applied as annual factors for availability and as constant percentages per hour; time-varying availability (planned outage calendars) is not yet modelled.
- BESS cycle degradation and throughput limits are stored but the legacy engine uses only the calendar SOH curve; the MILP consumes them.
- The diagram's resource icons are simple boxes; component geometry grows with capacity only for the PV array.
- Price profiles for IEX scenarios upload through the same endpoint (`kind=price`, `basis=capacity_factor` is wrong for them); the price basis `inr_per_kwh` is accepted by the model but the validator's bound check must be relaxed for prices (Day 4, when the MILP reads them).

## Next: Day 4 concrete work

1. MILP formulation (HiGHS via `highspy`): chronological balance per interval, technology bounds, grid import/export and node limits, BESS SOC continuity with charge/discharge efficiencies and limits, thermal/biomass commitment with minimum stable generation, ramps, minimum up/down times and start-up costs, fuel constraints, tender obligations (peak availability, annual CUF band, external sourcing allowance), RE attribution of storage, curtailment, shortage and penalty variables, IEX purchase and sale flows.
2. Tariff search: fixed-tariff MILP subproblems and a deterministic financial evaluator; monotonicity check before bisection; infeasible and time-limited subproblems classified separately; explicit certification boundary.
3. Workflow B: fixed tariff and capacities by default; dispatch optimisation as a selectable mode; capacity optimisation as an explicit alternative.
4. Durable run controls: cancel, time limit, gap, benchmark on a declared realistic case; full-resolution validation of the final candidate; independent physical and financial validator that recomputes from the exported decisions.
5. Analytical fixtures: energy balance, SOC, ramps, economics; feasible, infeasible and time-limited cases.
