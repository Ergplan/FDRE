"""Declared realistic benchmark for the MILP formulation.

Case A (LP): 300 MWac solar + 60 MW wind + 185 MW / 740 MWh BESS, 200 MW contracted,
hourly for one year (8,760 intervals), NHPC-style obligations.
Case B (MILP): case A plus one 50 MW biomass unit with commitment (8,760 binaries),
and IEX purchase at a flat price scenario.
Reports variables, constraints, binaries, wall time, peak RSS and the solver status/gap.
Run: .venv/bin/python tools/benchmark_milp.py [time_limit_seconds]
"""

from __future__ import annotations

import json
import pathlib
import resource
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from fdre_platform.optimization import certify, model
from fdre_platform.optimization.spec import BessUnit, DispatchSpec, Market, Obligations, ReUnit, ThermalUnit, month_index, peak_intervals_from_hours
from fdre_platform.supply.profiles import scale_to_cuf, synthetic_hourly


def case(with_thermal: bool, tariff: float = 4.0) -> DispatchSpec:
    T = 8760
    solar, _ = scale_to_cuf(synthetic_hourly("solar", 0.24), 0.24)
    wind, _ = scale_to_cuf(synthetic_hourly("wind", 0.32, seed=7), 0.32)
    re = [ReUnit("Solar", 300.0, [v * 300.0 * 0.99 for v in solar]), ReUnit("Wind", 60.0, [v * 60.0 * 0.97 for v in wind])]
    bess = [BessUnit("BESS", 185.0, 185.0, 185.0, 700.0, 0.93, 0.93, 0.5, 0.98, cycles_per_day_limit=1.5)]
    thermal = (
        [ThermalUnit("Biomass", "biomass", 50.0, 20.0, 60.0, 60.0, 4, 3, 500000.0, 0.0, 4200.0, 3600.0, 0.92, 0.10, 250000.0, renewable=True)]
        if with_thermal
        else []
    )
    market = (
        Market(
            enabled=with_thermal,
            purchase_enabled=with_thermal,
            sale_enabled=False,
            purchase_limit_mw=50.0,
            purchase_price_inr_per_kwh=[4.5] * T,
            delivery_loss=0.03,
        )
        if with_thermal
        else Market()
    )
    ob = Obligations(
        contracted_capacity_mw=200.0,
        peak_intervals=peak_intervals_from_hours(T, 1.0, {7, 8, 19, 20}),
        peak_availability_floor=0.9,
        annual_cuf_floor=0.34,
        annual_cuf_cap=0.44,
        cuf_hours_per_year=8766,
        penalty_multiplier=1.5,
        external_sourcing_max_fraction=0.05 if with_thermal else 0.0,
        psm_charge_inr_per_kwh=0.02,
    )
    return DispatchSpec(
        intervals=T,
        dt_hours=1.0,
        month_of_interval=month_index(T, 1.0),
        re_units=re,
        thermal_units=thermal,
        bess_units=bess,
        market=market,
        obligations=ob,
        interconnection_limit_mw=400.0,
        tariff_inr_per_kwh=tariff,
        merchant_price_inr_per_kwh=[3.0] * T,
    )


def run(name: str, spec: DispatchSpec, limit: float) -> dict:
    t0 = time.perf_counter()
    res = model.solve(spec, time_limit_seconds=limit, mip_rel_gap=0.005)
    rep = certify.certify(spec, res.dispatch, solver_objective=res.objective) if res.dispatch else None
    rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    out = {
        "case": name,
        "status": res.status,
        "solver_status": res.solver_status,
        "variables": res.n_variables,
        "constraints": res.n_constraints,
        "binaries": res.n_binaries,
        "wall_seconds": round(time.perf_counter() - t0, 2),
        "solver_seconds": res.wall_seconds,
        "objective_inr": res.objective,
        "best_bound_inr": res.best_bound,
        "gap": res.gap,
        "peak_rss_mb": round(rss_mb, 1),
        "certified": rep.status if rep else None,
        "ppa_gwh": round(res.aggregates.get("ppa_mwh", 0) / 1000, 2),
        "penalty_mwh": res.aggregates.get("total_penalty_mwh"),
        "peak_ok": res.aggregates.get("peak_ok"),
        "annual_cuf": res.aggregates.get("annual_cuf"),
    }
    print(json.dumps(out))
    return out


if __name__ == "__main__":
    limit = float(sys.argv[1]) if len(sys.argv) > 1 else 120.0
    results = [run("A_lp_solar_wind_bess_8760h", case(False), limit), run("B_milp_plus_biomass_iex_8760h", case(True), limit)]
    json.dump(results, open("docs/platform/benchmark-milp.json", "w"), indent=1)
