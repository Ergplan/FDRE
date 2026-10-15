"""The immutable dispatch specification: everything the MILP needs, as plain arrays, with
the tender obligations as numbers. Built from a scenario's compiled supply configuration,
its approved rule set and the run options; hashed into the run snapshot."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

HOURS = 8760


@dataclass
class ReUnit:
    name: str
    capacity_mw: float
    available_mw: list[float]      # per interval, at the POI after the loss chain and availability (MW)
    curtailable: bool = True
    technology: str = "solar"
    node: str = "POI"


@dataclass
class ThermalUnit:
    name: str
    technology: str                # thermal | biomass
    capacity_mw: float
    min_stable_mw: float
    ramp_up_mw_per_interval: float
    ramp_down_mw_per_interval: float
    min_up_intervals: int
    min_down_intervals: int
    startup_cost_inr: float
    shutdown_cost_inr: float
    variable_cost_inr_per_mwh: float    # fuel + variable O&M, on net output
    fuel_cost_inr_per_mwh: float
    availability: float                 # 0-1 derating for outages
    aux_fraction: float                 # auxiliary consumption on gross
    annual_energy_cap_mwh: float | None # from fuel availability
    cost_segments: list[tuple[float, float]] = field(default_factory=list)  # (from_mw, inr_per_mwh)
    renewable: bool = False             # biomass counts as RE when the tender says so
    eligible: bool = True


@dataclass
class BessUnit:
    name: str
    power_mw: float
    charge_limit_mw: float
    discharge_limit_mw: float
    usable_mwh: float
    eff_charge: float
    eff_discharge: float
    aux_mw: float
    availability: float
    soc_initial_fraction: float = 0.5
    throughput_cap_mwh: float | None = None
    cycles_per_day_limit: float | None = None
    charging_sources: tuple[str, ...] = ("re_colocated",)
    renewable_attribution: str = "re_charged_only"
    node: str = "POI"


@dataclass
class Market:
    enabled: bool = False
    purchase_enabled: bool = False
    sale_enabled: bool = False
    purchase_limit_mw: float = 0.0
    purchase_limit_mwh_per_day: float | None = None
    sale_limit_mw: float = 0.0
    purchase_price_inr_per_kwh: list[float] = field(default_factory=list)   # per interval
    sale_price_inr_per_kwh: list[float] = field(default_factory=list)
    purchase_charges_inr_per_kwh: float = 0.0
    sale_charges_inr_per_kwh: float = 0.0
    delivery_loss: float = 0.0
    purchase_counts_as_renewable: bool = False
    purchase_price_scenario: str = ""
    sale_price_scenario: str = ""


@dataclass
class Obligations:
    """Tender rules as the formulation consumes them."""

    contracted_capacity_mw: float
    peak_intervals: list[int]               # interval indexes that are peak hours
    peak_availability_floor: float          # fraction of contracted capacity, per month in energy terms
    annual_cuf_floor: float                 # declared CUF x (1 - lower tolerance)
    annual_cuf_cap: float                   # declared CUF x upper multiplier
    cuf_hours_per_year: float               # 8766 in the NHPC convention
    penalty_multiplier: float               # x tariff on shortfall energy
    external_sourcing_max_fraction: float   # share of delivered energy that may come from the market
    non_peak_take_fraction: float = 1.0     # buyer takes this share of CC outside peak hours
    merchant_sales_allowed: bool = True
    re_share_min_fraction: float | None = None
    storage_charging_re_only: bool = True
    psm_charge_inr_per_kwh: float = 0.0


@dataclass
class DispatchSpec:
    intervals: int
    dt_hours: float
    month_of_interval: list[int]            # 1..12 per interval
    re_units: list[ReUnit]
    thermal_units: list[ThermalUnit]
    bess_units: list[BessUnit]
    market: Market
    obligations: Obligations
    interconnection_limit_mw: float
    tariff_inr_per_kwh: float               # the fixed tariff of this subproblem
    merchant_price_inr_per_kwh: list[float] = field(default_factory=list)  # fallback sale price when no market module
    year: int = 1
    rules_version: str = ""
    formulation_version: str = "milp.v1"
    notes: list[str] = field(default_factory=list)

    def fingerprint(self) -> str:
        payload = {
            "intervals": self.intervals, "dt": self.dt_hours, "re": [(u.name, u.capacity_mw, round(sum(u.available_mw), 3)) for u in self.re_units],
            "thermal": [(u.name, u.capacity_mw, u.min_stable_mw, u.variable_cost_inr_per_mwh, u.startup_cost_inr) for u in self.thermal_units],
            "bess": [(b.name, b.power_mw, b.usable_mwh, b.eff_charge, b.eff_discharge) for b in self.bess_units],
            "market": [self.market.enabled, self.market.purchase_limit_mw, self.market.sale_limit_mw, round(sum(self.market.purchase_price_inr_per_kwh), 3), round(sum(self.market.sale_price_inr_per_kwh), 3)],
            "obligations": self.obligations.__dict__ | {"peak_intervals": len(self.obligations.peak_intervals)}, "limit": self.interconnection_limit_mw, "tariff": self.tariff_inr_per_kwh, "year": self.year, "formulation": self.formulation_version,
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


def month_index(intervals: int, dt_hours: float) -> list[int]:
    days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    per_day = int(round(24 / dt_hours))
    out: list[int] = []
    for m, d in enumerate(days, start=1):
        out.extend([m] * (d * per_day))
    return out[:intervals] if len(out) >= intervals else out + [12] * (intervals - len(out))


def peak_intervals_from_hours(intervals: int, dt_hours: float, hours: set[int]) -> list[int]:
    per_day = int(round(24 / dt_hours))
    out = []
    for t in range(intervals):
        hour = int((t % per_day) * dt_hours)
        if hour in hours:
            out.append(t)
    return out


def thermal_variable_cost(heat_rate_kcal_per_kwh: float, calorific_value_kcal_per_kg: float, price_inr_per_tonne: float, vom_inr_per_mwh: float) -> tuple[float, float]:
    """Fuel cost per net MWh from heat rate (kcal per kWh), calorific value and price; plus VOM."""
    kcal_per_mwh = heat_rate_kcal_per_kwh * 1000.0
    tonnes_per_mwh = kcal_per_mwh / (calorific_value_kcal_per_kg * 1000.0)
    fuel = tonnes_per_mwh * price_inr_per_tonne
    return fuel, fuel + vom_inr_per_mwh


def spec_from_inputs(inputs: dict[str, Any], *, tariff: float, year: int = 1, resolution_minutes: int = 60, market_scenario: str | None = None, price_lookup=None) -> DispatchSpec:
    """Build the spec from scenario inputs: `supply` (modules), `project` (legacy tender
    and simulation defaults), `supply_compiled` (profile columns), `rules` (optional,
    compiled rule values)."""
    dt = resolution_minutes / 60.0
    intervals = int(round(HOURS / dt))
    project = inputs.get("project", {})
    tender = project.get("tender", {})
    supply = inputs.get("supply") or {"modules": []}
    compiled = inputs.get("supply_compiled") or {}
    custom_cf = compiled.get("custom_cf") or {}
    recs = {r["module_id"]: r for r in compiled.get("reconciliations", [])}
    re_units: list[ReUnit] = []
    thermal_units: list[ThermalUnit] = []
    bess_units: list[BessUnit] = []
    market = Market()
    notes: list[str] = []
    degradation_year = max(0, year - 1)
    for m in supply.get("modules", []):
        if not m.get("enabled", True):
            continue
        kind = m["kind"]
        if kind in ("solar", "wind"):
            cap = m["mwac"] if kind == "solar" else m["installed_mw"]
            safe = "".join(ch if ch.isalnum() else "_" for ch in m["name"].strip().lower()).strip("_")
            cf = custom_cf.get(f"gen_{safe}")
            if cf is None:
                from fdre_platform.supply.profiles import scale_to_cuf, synthetic_hourly

                cuf = (m.get("profile") or {}).get("synthetic_cuf_percent") or 20.0
                cf, _ = scale_to_cuf(synthetic_hourly(kind, cuf / 100.0), cuf / 100.0)
                notes.append(f"{m['name']}: synthetic profile at {cuf}% CUF (no compiled column)")
            rec = recs.get(m["id"], {})
            avail = rec.get("availability_factor", 1.0)
            evac = 1.0 - rec.get("transmission_loss_percent", 0.0) / 100.0
            deg = (1.0 - m.get("degradation_percent_per_year", 0.0) / 100.0) ** degradation_year
            hourly = [max(0.0, min(1.0, v)) * cap * avail * evac * deg for v in cf]
            series = _resample(hourly, intervals)
            re_units.append(ReUnit(name=m["name"], capacity_mw=cap, available_mw=series, technology=kind, node=m.get("node", "POI")))
        elif kind in ("thermal", "biomass"):
            heat_rate = m.get("heat_rate_kcal_per_kwh") or (860.0 / (m["efficiency_percent"] / 100.0))
            fuel = m["fuel"]
            fuel_cost, var_cost = thermal_variable_cost(heat_rate, fuel["calorific_value_kcal_per_kg"], fuel["price_inr_per_tonne"] * (1 + fuel.get("escalation_percent_per_year", 0) / 100.0) ** degradation_year, m["variable_om_inr_per_mwh"])
            cap_energy = None
            if fuel.get("availability_tonnes_per_year"):
                kcal = fuel["availability_tonnes_per_year"] * 1000.0 * fuel["calorific_value_kcal_per_kg"]
                cap_energy = kcal / (heat_rate * 1000.0)
            availability = (1 - m["planned_outage_percent"] / 100.0) * (1 - m["forced_outage_percent"] / 100.0)
            thermal_units.append(
                ThermalUnit(
                    name=m["name"], technology=kind, capacity_mw=m["capacity_mw"], min_stable_mw=m["capacity_mw"] * m["min_stable_generation_percent"] / 100.0,
                    ramp_up_mw_per_interval=m["ramp_up_mw_per_min"] * resolution_minutes, ramp_down_mw_per_interval=m["ramp_down_mw_per_min"] * resolution_minutes,
                    min_up_intervals=int(round(m["min_up_time_h"] / dt)), min_down_intervals=int(round(m["min_down_time_h"] / dt)), startup_cost_inr=m["startup_cost_inr"], shutdown_cost_inr=m.get("shutdown_cost_inr", 0.0),
                    variable_cost_inr_per_mwh=var_cost, fuel_cost_inr_per_mwh=fuel_cost, availability=availability, aux_fraction=m["auxiliary_consumption_percent"] / 100.0, annual_energy_cap_mwh=cap_energy,
                    cost_segments=[(s["from_mw"], s["inr_per_mwh"]) for s in m.get("cost_segments", [])], renewable=(kind == "biomass"), eligible=bool((m.get("eligibility") or {}).get("allowed", True)),
                )
            )
        elif kind == "bess":
            usable = m["energy_mwh"] * (m["soc_max_percent"] - m["soc_min_percent"]) / 100.0 * (1 - m.get("calendar_degradation_percent_per_year", 0) / 100.0) ** degradation_year
            bess_units.append(
                BessUnit(
                    name=m["name"], power_mw=m["power_mw"], charge_limit_mw=m.get("charge_limit_mw") or m["power_mw"], discharge_limit_mw=m.get("discharge_limit_mw") or m["power_mw"], usable_mwh=usable,
                    eff_charge=m["charge_efficiency_percent"] / 100.0, eff_discharge=m["discharge_efficiency_percent"] / 100.0, aux_mw=m.get("auxiliary_load_kw", 0.0) / 1000.0, availability=m["availability_percent"] / 100.0,
                    throughput_cap_mwh=m.get("throughput_limit_mwh_per_year"), cycles_per_day_limit=m.get("cycles_per_day_limit"), charging_sources=tuple(m.get("charging_sources", ["re_colocated"])), renewable_attribution=m.get("renewable_attribution", "re_charged_only"), node=m.get("node", "POI"),
                )
            )
        elif kind == "iex":
            buy = _price_series(m.get("purchase_price_scenarios", []), market_scenario, price_lookup, intervals)
            sell = _price_series(m.get("sale_price_scenarios", []), market_scenario, price_lookup, intervals)
            market = Market(
                enabled=True, purchase_enabled=bool(m.get("purchase_enabled", True)) and buy is not None, sale_enabled=bool(m.get("sale_enabled", True)) and sell is not None,
                purchase_limit_mw=m.get("purchase_limit_mw", 0.0), purchase_limit_mwh_per_day=m.get("purchase_limit_mwh_per_day"), sale_limit_mw=m.get("sale_limit_mw", 0.0),
                purchase_price_inr_per_kwh=buy or [], sale_price_inr_per_kwh=sell or [], purchase_charges_inr_per_kwh=m.get("purchase_charges_inr_per_kwh", 0.0), sale_charges_inr_per_kwh=m.get("sale_charges_inr_per_kwh", 0.0),
                delivery_loss=m.get("delivery_loss_percent", 0.0) / 100.0, purchase_counts_as_renewable=bool(m.get("purchase_counts_as_renewable", False)),
                purchase_price_scenario=(buy and _scenario_name(m.get("purchase_price_scenarios", []), market_scenario)) or "", sale_price_scenario=(sell and _scenario_name(m.get("sale_price_scenarios", []), market_scenario)) or "",
            )
            if buy is None and m.get("purchase_enabled", True):
                notes.append("IEX purchase disabled: no price scenario attached")
            if sell is None and m.get("sale_enabled", True):
                notes.append("IEX sale disabled: no price scenario attached")
    # Legacy project generators when no supply configuration exists (Day 1/2 scenarios).
    if not supply.get("modules") and project.get("generators"):
        from fdre_platform.supply.profiles import scale_to_cuf, synthetic_hourly

        for g in project["generators"]:
            cf = custom_cf.get(f"gen_{g['name']}") or scale_to_cuf(synthetic_hourly(g["technology"], g.get("cuf", 0.25)), g.get("cuf", 0.25))[0]
            deg = (1.0 - g.get("degradation_per_year", 0.0)) ** degradation_year
            re_units.append(ReUnit(name=g["name"], capacity_mw=g["ac_mw"], available_mw=_resample([max(0.0, min(1.0, v)) * g["ac_mw"] * g.get("availability", 1.0) * deg for v in cf], intervals), technology=g["technology"], node=g.get("node", "POI")))
        for b in project.get("bess", []):
            rte = b.get("rte", 0.87)
            bess_units.append(BessUnit(name=b["name"], power_mw=b["power_mw"], charge_limit_mw=b.get("charge_power_mw") or b["power_mw"], discharge_limit_mw=b.get("discharge_power_mw") or b["power_mw"], usable_mwh=b["usable_mwh_at_poi"], eff_charge=rte**0.5, eff_discharge=rte**0.5, aux_mw=0.0, availability=b.get("availability", 1.0), node=b.get("node", "POI")))
        notes.append("units taken from the legacy project (no supply configuration)")
    sim = project.get("simulation", {})
    hours = set(tender.get("fixed_morning_peak_hours", (7, 8))) | set(tender.get("fixed_evening_peak_hours", (19, 20)))
    obligations = Obligations(
        contracted_capacity_mw=float(tender.get("contracted_capacity_mw", 100.0)), peak_intervals=peak_intervals_from_hours(intervals, dt, hours), peak_availability_floor=float(tender.get("peak_availability_floor", 0.9)),
        annual_cuf_floor=float(tender.get("declared_annual_cuf", 0.4)) * (1 - float(tender.get("cuf_lower_tolerance", 0.15))), annual_cuf_cap=float(tender.get("declared_annual_cuf", 0.4)) * float(tender.get("cuf_upper_multiplier", 1.1)),
        cuf_hours_per_year=float(tender.get("cuf_hours_per_year", 8766)), penalty_multiplier=float(tender.get("penalty_multiplier", 1.5)), external_sourcing_max_fraction=float(tender.get("external_green_limit_fraction", 0.05)) if tender.get("allow_external_green_purchase", False) or market.purchase_enabled else 0.0,
        non_peak_take_fraction=float(tender.get("ppa_non_peak_take_fraction", 1.0)), merchant_sales_allowed=True, storage_charging_re_only=True, psm_charge_inr_per_kwh=float(tender.get("psm_charge_rs_per_kwh", 0.0)),
    )
    limit = sum(n.get("interconnection_limit_mw", 0.0) for n in (supply.get("nodes") or project.get("nodes") or [])) or 1e6
    merchant = float(sim.get("merchant_price_rs_per_kwh", 3.25)) * (1 + float(sim.get("merchant_escalation", 0.02))) ** degradation_year
    haircut = 1.0 - float(sim.get("merchant_curtailment_haircut", 0.08))
    return DispatchSpec(
        intervals=intervals, dt_hours=dt, month_of_interval=month_index(intervals, dt), re_units=re_units, thermal_units=thermal_units, bess_units=bess_units, market=market, obligations=obligations,
        interconnection_limit_mw=limit, tariff_inr_per_kwh=tariff, merchant_price_inr_per_kwh=[merchant * haircut] * intervals, year=year, rules_version=str(inputs.get("rules_version") or ""), notes=notes,
    )


def _resample(hourly: list[float], intervals: int) -> list[float]:
    if len(hourly) == intervals:
        return list(hourly)
    k = intervals // len(hourly)
    if k >= 1 and intervals % len(hourly) == 0:
        return [v for v in hourly for _ in range(k)]
    step = len(hourly) / intervals
    return [hourly[min(len(hourly) - 1, int(i * step))] for i in range(intervals)]


def _price_series(scenarios: list[dict[str, Any]], chosen: str | None, lookup, intervals: int) -> list[float] | None:
    if not scenarios or lookup is None:
        return None
    sc = next((s for s in scenarios if s.get("name") == chosen), scenarios[0])
    series = lookup(sc["profile_id"])
    if series is None:
        return None
    return _resample(list(series), intervals)


def _scenario_name(scenarios: list[dict[str, Any]], chosen: str | None) -> str:
    sc = next((s for s in scenarios if s.get("name") == chosen), scenarios[0] if scenarios else None)
    return sc["name"] if sc else ""
