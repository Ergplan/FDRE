"""Day 4 gate: analytical fixtures for the MILP (energy balance, SOC continuity, ramps,
commitment, obligations, economics) and the classification of feasible, infeasible and
time-limited cases. Every fixture is checked by the independent certifier, never by the
solver's own residuals."""

from __future__ import annotations

import numpy as np
import pytest

from fdre_platform.optimization import certify, model
from fdre_platform.optimization.spec import BessUnit, DispatchSpec, Market, Obligations, ReUnit, ThermalUnit


def _spec(
    T=24,
    *,
    re=None,
    thermal=None,
    bess=None,
    market=None,
    cc=10.0,
    tariff=4.0,
    peak_hours=(7, 8, 19, 20),
    floor=0.9,
    cuf_floor=0.0,
    cuf_cap=10.0,
    penalty=1.5,
    ext=0.0,
    limit=1000.0,
    merchant=2.0,
    take=1.0,
):
    dt = 1.0
    peak = [t for t in range(T) if (t % 24) in peak_hours]
    return DispatchSpec(
        intervals=T,
        dt_hours=dt,
        month_of_interval=[1] * T,
        re_units=re or [],
        thermal_units=thermal or [],
        bess_units=bess or [],
        market=market or Market(),
        obligations=Obligations(
            contracted_capacity_mw=cc,
            peak_intervals=peak,
            peak_availability_floor=floor,
            annual_cuf_floor=cuf_floor,
            annual_cuf_cap=cuf_cap,
            cuf_hours_per_year=T,
            penalty_multiplier=penalty,
            external_sourcing_max_fraction=ext,
            non_peak_take_fraction=take,
        ),
        interconnection_limit_mw=limit,
        tariff_inr_per_kwh=tariff,
        merchant_price_inr_per_kwh=[merchant] * T,
    )


def _certified(spec, res):
    rep = certify.certify(spec, res.dispatch, solver_objective=res.objective)
    assert rep.status == "certified", [i.__dict__ for i in rep.issues[:5]]
    return rep


def test_re_only_delivers_up_to_contracted_capacity_and_sells_surplus():
    avail = [0.0] * 6 + [20.0] * 12 + [0.0] * 6  # 20 MW available from 06:00 to 18:00
    spec = _spec(re=[ReUnit("solar", 20.0, avail)], cc=10.0, tariff=4.0, merchant=2.0)
    res = model.solve(spec, time_limit_seconds=30)
    assert res.status == "optimal" and res.n_binaries == 0
    _certified(spec, res)
    d = res.dispatch
    assert np.allclose(d["delivered_mw"][6:18], 10.0) and np.allclose(d["sold_mw"][6:18], 10.0)
    # Peak at 7 and 8 covered, 19 and 20 not: shortfall 2 x 0.9 x 10 ... monthly energy test: required 0.9 x 10 x 4 = 36, delivered 20 -> shortfall 16
    assert res.aggregates["peak_shortfall_mwh"] == pytest.approx(16.0)
    # Economics recomputed: revenue 120 MWh x 4000 + 120 x 2000 - penalty 16 x 1.5 x 4000
    expected = -(120 * 4000 + 120 * 2000) + 16 * 1.5 * 4000
    assert res.objective == pytest.approx(expected)


def test_bess_shifts_solar_into_evening_peak_with_soc_continuity():
    avail = [0.0] * 6 + [20.0] * 12 + [0.0] * 6
    bess = BessUnit(
        "bess", power_mw=10, charge_limit_mw=10, discharge_limit_mw=10, usable_mwh=40, eff_charge=0.95, eff_discharge=0.95, aux_mw=0.0, availability=1.0
    )
    spec = _spec(re=[ReUnit("solar", 20.0, avail)], bess=[bess], cc=10.0, tariff=4.0, merchant=2.0)
    res = model.solve(spec, time_limit_seconds=30)
    assert res.status == "optimal"
    rep = _certified(spec, res)
    d = res.dispatch
    # Evening peak hours 19 and 20 are now served from storage; no peak shortfall remains.
    assert d["delivered_mw"][19] == pytest.approx(10.0) and d["delivered_mw"][20] == pytest.approx(10.0)
    assert res.aggregates["peak_shortfall_mwh"] == pytest.approx(0.0)
    soc = d["bess"]["bess"]["soc"]
    ch, dis = d["bess"]["bess"]["charge"], d["bess"]["bess"]["discharge"]
    for t in range(24):
        assert soc[t] == pytest.approx(soc[t - 1] + 0.95 * ch[t] - dis[t] / 0.95, abs=1e-6)  # circular recursion
    assert rep.max_residual["b_soc_continuity:bess"] < 1e-6
    # RE-only charging: everything that went into the battery came from the solar unit.
    assert np.allclose(ch, d["re"]["solar"]["charge"])


def test_thermal_commitment_minimum_stable_generation_ramps_and_up_down_times():
    th = ThermalUnit(
        "bio",
        "biomass",
        capacity_mw=10,
        min_stable_mw=4,
        ramp_up_mw_per_interval=3,
        ramp_down_mw_per_interval=3,
        min_up_intervals=4,
        min_down_intervals=3,
        startup_cost_inr=5000,
        shutdown_cost_inr=0,
        variable_cost_inr_per_mwh=3000,
        fuel_cost_inr_per_mwh=2500,
        availability=1.0,
        aux_fraction=0.0,
        annual_energy_cap_mwh=None,
        renewable=True,
    )
    spec = _spec(T=48, thermal=[th], cc=10.0, tariff=5.0, merchant=0.5, floor=0.9, penalty=1.5)
    res = model.solve(spec, time_limit_seconds=60, mip_rel_gap=1e-6)
    assert res.status == "optimal" and res.n_binaries == 48
    _certified(spec, res)
    d = res.dispatch["thermal"]["bio"]
    p, on = d["p"], d["on"]
    assert np.all(p <= 10 + 1e-6) and np.all(p[on > 0.5] >= 4 - 1e-6) and np.all(p[on < 0.5] <= 1e-6)
    assert np.all(np.diff(p) <= 3 + 10 * d["start"][1:] + 1e-6)
    # Serving the four peak hours costs 3000/MWh against a 5000/MWh tariff: the unit runs through the peaks.
    peak = [t for t in range(48) if t % 24 in (7, 8, 19, 20)]
    assert all(p[t] >= 9 - 1e-6 for t in peak)
    assert res.aggregates["peak_shortfall_mwh"] == pytest.approx(0.0)
    assert res.aggregates["thermal_mwh"]["bio"] == pytest.approx(p.sum())


def test_market_purchase_bounded_by_external_sourcing_allowance():
    avail = [0.0] * 24
    market = Market(enabled=True, purchase_enabled=True, sale_enabled=False, purchase_limit_mw=10, purchase_price_inr_per_kwh=[3.0] * 24, delivery_loss=0.02)
    spec = _spec(re=[ReUnit("solar", 20.0, avail)], market=market, cc=10.0, tariff=4.0, ext=0.5, cuf_floor=0.0)
    res = model.solve(spec, time_limit_seconds=30)
    assert res.status == "optimal"
    _certified(spec, res)
    # All delivered energy would be external; the allowance caps it: delivered = buy_ppa <= 0.5 delivered -> only 0 is feasible... so nothing is delivered.
    assert res.aggregates["ppa_mwh"] == pytest.approx(0.0, abs=1e-6)
    spec2 = _spec(re=[ReUnit("solar", 20.0, [0.0] * 6 + [20.0] * 12 + [0.0] * 6)], market=market, cc=10.0, tariff=4.0, ext=0.5)
    res2 = model.solve(spec2, time_limit_seconds=30)
    _certified(spec2, res2)
    ext = res2.aggregates["external_green_mwh"]
    assert 0 < ext <= 0.5 * res2.aggregates["ppa_mwh"] + 1e-6
    assert res2.aggregates["iex_purchase_mwh"] == pytest.approx(ext / 0.98)


def test_infeasible_and_time_limited_cases_are_classified():
    # Infeasible: the annual floor cannot be met with no allowed shortfall penalty path? The floor always has a shortfall variable,
    # so infeasibility must come from a hard constraint: a cap below the floor.
    spec = _spec(re=[ReUnit("solar", 20.0, [20.0] * 24)], cc=10.0, cuf_floor=0.9, cuf_cap=0.1)
    spec.obligations.annual_cuf_cap = 0.0
    spec.obligations.annual_cuf_floor = 0.5
    # cap 0 forces delivered = 0, floor met through the shortfall variable (penalised), so still feasible; make it hard:
    spec.interconnection_limit_mw = -1.0  # impossible export bound
    res = model.solve(spec, time_limit_seconds=30)
    assert res.status == "infeasible" and res.dispatch == {}
    th = ThermalUnit(
        "coal",
        "thermal",
        capacity_mw=10,
        min_stable_mw=4,
        ramp_up_mw_per_interval=3,
        ramp_down_mw_per_interval=3,
        min_up_intervals=4,
        min_down_intervals=3,
        startup_cost_inr=5000,
        shutdown_cost_inr=0,
        variable_cost_inr_per_mwh=3000,
        fuel_cost_inr_per_mwh=2500,
        availability=1.0,
        aux_fraction=0.0,
        annual_energy_cap_mwh=None,
    )
    big = _spec(T=24 * 30, thermal=[th, ThermalUnit("coal2", "thermal", 10, 4, 3, 3, 4, 3, 5000, 0, 3100, 2600, 1.0, 0.0, None)], cc=10.0, tariff=5.0)
    res = model.solve(big, time_limit_seconds=0.05)
    assert res.status in ("feasible_time_limit", "time_limit_no_solution", "optimal")
    if res.status == "feasible_time_limit":
        assert res.gap is not None and res.best_bound is not None and res.dispatch


def test_certifier_catches_a_tampered_dispatch():
    avail = [0.0] * 6 + [20.0] * 12 + [0.0] * 6
    spec = _spec(re=[ReUnit("solar", 20.0, avail)], cc=10.0)
    res = model.solve(spec, time_limit_seconds=30)
    tampered = {**res.dispatch, "delivered_mw": res.dispatch["delivered_mw"] + 1.0}
    rep = certify.certify(spec, tampered, solver_objective=res.objective)
    assert rep.status == "failed" and any(i.check == "delivered_definition" for i in rep.issues)
