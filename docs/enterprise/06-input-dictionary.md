# Input Ownership And Unit Dictionary

Proposed canonical names below are not existing API keys. The migration layer
maps legacy keys explicitly; clients cannot infer mappings from display labels.
Every value also has a version, provenance, source/basis date and validation state.

## Tender And Project

| Canonical field | Unit/type | Owner screen | Validation / notes |
|---|---|---|---|
| `tender.procurement_power` | MW | Approved Rules | Total procurement, not project bid size |
| `tender.procurement_energy` | MWh per stated period | Approved Rules | Period mandatory; do not infer from power alone |
| `project.contracted_power` | MW AC at delivery point | Project Setup | One fixed value, eligible tender minimum/maximum/multiple |
| `contract.term` | Years or dated interval | Approved Rules | Term basis and partial-year handling explicit |
| `contract.start_basis` | COD/SCD/effective-date rule | Approved Rules | No silent conversion among these dates |
| `calendar.timezone` | IANA zone | Project Setup | Market calendar and UTC conversion retained |
| `calendar.interval_minutes` | Integer minutes | Approved Rules | Must divide the applicable settlement schedule correctly |
| `calendar.contract_week_anchor` | Date/time and policy | Approved Rules | Required for weekly tests; cannot assume calendar month grouping |
| `delivery.schedule_policy` | Registered enum | Approved Rules | Fixed/buyer schedule/day-ahead block selection |
| `delivery.peak_windows` | Local clock intervals | Approved Rules | Half-open intervals and midnight handling |
| `delivery.energy_per_mw` | kWh/MW/day or MWh/MW/week | Approved Rules | Do not label energy as availability percentage |
| `availability.threshold` | Ratio | Approved Rules | Metric definition and denominator required |
| `cuf.declared` | Ratio | Project Setup, constrained by rules | Null when not applicable; floor not defaulted to 40% |
| `cuf.lower_tolerance` | Relative ratio or percentage-point type | Approved Rules | Explicit operator; 15% relative is not 15 percentage points |
| `cuf.denominator_hours` | Hours or calendar-derived | Approved Rules | Legacy convention preserved only where intended |
| `external_green.limit` | Ratio with energy basis | Approved Rules | Eligibility/provenance and charging/discharge treatment |
| `grid.export_limit` | MW AC at named node | Project Setup | Enforced each interval |
| `grid.losses` | Ratio and boundary | Project Setup | Avoid duplication with site-net profiles |

## Resource And Sizing

| Canonical field | Unit/type | Owner screen | Validation / notes |
|---|---|---|---|
| `site.coordinates` | Latitude/longitude + CRS | Project Setup | Range and CRS required |
| `solar.dc_ac_ratio` | MW DC / MW AC | Solar Yield | Positive; distinguish report basis |
| `profile.normalized_output` | MW per MW AC or explicit CF | Yield Assessment | Time index, gaps, duplicates, quality and losses manifest |
| `profile.p_level` | P50/P75/P90/P95 | Yield Assessment | Method, uncertainty horizon and correlation assumptions |
| `profile.synthetic` | Boolean + generation method | Yield Assessment | Synthetic status shown in results/reports |
| `wind.turbine_rating` | MW per turbine | Wind Yield | Count-based capacity computed, not invented |
| `wind.count_policy` | Integer/continuous study | Wind Yield | Continuous mode cannot imply a buildable count |
| `losses.waterfall` | Ordered ratios and inclusion flags | Yield Assessment | Multiplicative vs additive methodology explicit |
| `uncertainty.components` | Ratios with correlation policy | Yield Assessment | RSS only for justified independence assumptions |
| `bounds.site_capacity` | Min/max MW AC per site | Optimization | Within physical and tender caps |
| `bounds.bess_power` | Min/max MW | Optimization | Separate from storage energy |
| `bounds.bess_energy` | Min/max MWh nameplate | Optimization | Independent unless duration constrained |
| `custom.asset_sizes` | Fixed MW/MWh | Custom Dispatch | Never overwrites optimization bounds or approved winner |

## BESS

| Canonical field | Unit/type | Owner screen | Validation / notes |
|---|---|---|---|
| `bess.power_basis` | PCS terminals/PoI | BESS Yield | Rating and losses consistent |
| `bess.nameplate_energy` | MWh | Custom Dispatch / optimized result | Nameplate distinct from usable energy |
| `bess.soc_min/max` | Ratio of defined capacity | BESS Yield | Ordered limits; DoD relationship validated |
| `bess.eta_charge/discharge` | Ratio | BESS Yield | RTE relation and auxiliary losses explicit |
| `bess.rte` | Ratio | BESS Yield | Do not impose both RTE and separate efficiencies inconsistently |
| `bess.availability` | Ratio or outage schedule | BESS Yield | Deterministic derating vs outage scenario distinguished |
| `bess.soh_schedule` | Age-indexed ratio | BESS Yield | Monotonic except documented cohort replacement/augmentation |
| `bess.augmentation` | Cohort MW/MWh and commissioning date | BESS Yield | Physical change invalidates dispatch; price-only change may not |
| `bess.terminal_soc_policy` | Registered enum | Project Setup | Initial/terminal and interyear consistency |

## Financial And Market Inputs

| Canonical field | Unit/type | Owner screen | Validation / notes |
|---|---|---|---|
| `capex.solar` | INR/MW AC or DC, stated | Financial Inputs | EPC scope and exclusions |
| `capex.wind` | INR/MW | Financial Inputs | Turbine/EPC scope and turbine-count policy |
| `capex.bess_energy` | INR/MWh nameplate | Financial Inputs | Cells/container/energy subsystem scope |
| `capex.bess_power` | INR/MW | Financial Inputs | PCS/power subsystem; prevent overlap with all-in quotes |
| `capex.land_development` | Technology-specific INR/MW or area basis | Financial Inputs | Explicit area/rate conversion or per-MW assumption |
| `capex.transmission` | INR/MW or documented lump sum | Financial Inputs | Basis: contracted/export/installed MW, not implicit maximum |
| `capex.owners_contingency` | Fixed/per-unit/ratio | Financial Inputs | Mutually clear basis and included cost categories |
| `opex.technology` | INR/MW/year or INR/MWh/year | Financial Inputs | Asset-specific rates, escalation and start year |
| `opex.transmission` | Capacity fee or energy charge | Financial Inputs | Demand, wheeling, losses and tariffs separated |
| `opex.admin` | INR/year and/or per-MW | Financial Inputs | Shared-cost allocation disclosed |
| `augmentation.unit_cost` | INR/MWh at basis year | Financial Inputs | Cost decline, floor, real/nominal convention |
| `finance.debt_fraction` | Ratio | Financial Inputs | Requested and realized gearing separately displayed |
| `finance.debt_rate` | Annual ratio | Financial Inputs | Rate/reset schedule and compounding basis |
| `finance.tenor` | Years/payment periods | Financial Inputs | Construction/repayment start and grace period |
| `finance.repayment_style` | Annuity/sculpted | Financial Inputs | Tax/interest circularity tolerance recorded |
| `finance.target_equity_return` | Annual ratio | Financial Inputs | NPV/IRR time basis and hurdle definition |
| `finance.dscr_covenant` | Ratio | Financial Inputs | Period definition and debt-sizing policy |
| `tax.rates_depreciation` | Ratios/schedules | Financial Inputs | Jurisdiction/basis date, loss carry-forward policy |
| `working_capital.days` | Days per component | Financial Inputs | Receivables, payables, inventory and reserves |
| `working_capital.rate` | Annual ratio | Financial Inputs | Funding basis and final release policy |
| `market.mcp_series` | INR/kWh by interval | Markets | Forecast/realized labels, scenario and exchange |
| `market.cleared_volume` | MWh or clearing scenario | Markets | Offered != accepted/eligible energy |
| `settlement.strike_price` | INR/kWh | Financial Inputs / run result | Applicable only to adapter; not duplicate PPA tariff |
| `market.rec_price_fees` | INR/REC and typed fees | Markets | REC volume eligibility and pool-share rules |

Sensitivity edits create a versioned override of permitted financial fields.
They do not change these ownership boundaries or mutate the parent design.

## Legacy Mapping Inventory To Implement

`contractedCapacity` -> project fixed bid; `declaredCuf` -> ratio conversion;
`solarMinMw/solarMaxMw` and corresponding wind/BESS fields -> optimization bounds;
`solarAcMw/windMw/bessPowerMw/bessEnergyMwh` -> custom sizes or initial-design
values only as explicitly selected; `dispatchMorningPeakStart/End` and evening
fields -> approved schedule; `targetEquityIrr` -> financial hurdle.

Do not blindly map these keys to every family. The compatibility compiler is the
authority on applicability. Add a contract test for each accepted legacy mapping.
