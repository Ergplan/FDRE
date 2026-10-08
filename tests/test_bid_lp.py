"""Sizing LP extensions used by the Tender to Bid tab: a biomass plant and tender supply rules."""
from __future__ import annotations

import numpy as np
import pytest

import fdre_rtc_lp as M
from tests.test_rtc_lp import BESS, COSTS, FIN, _case

pytestmark = pytest.mark.skipif(M.highspy is None, reason="highspy not installed")

FIN0 = {**FIN, "solarDegradation": 0, "biomassOmLakhPerMw": 30.0, "biomassFuelRsPerKwh": 3.2, "biomassFuelEscalation": 0.03}
BESS0 = {**BESS, "annualDegradation": 0}
COSTS_BIO = {**COSTS, "biomassCrPerMw": 9.0}
HOUR = np.arange(M.HOURS) % 24


def _payload(**extra):
    solar, wind, _ = _case()
    payload = {
        "ctx": {"demand": [100.0] * M.HOURS, "solarCf": solar.tolist(), "windCf": wind.tolist(), "plantMw": 100},
        "bess": BESS0, "costs": COSTS_BIO, "fin": FIN0, "dfrTarget": 0.8, "dfrBasis": "annual",
        "tariffGuess": 6.0,
    }
    payload.update(extra)
    return payload


def test_biomass_alone_is_sized_by_its_fuel_limit():
    payload = _payload(
        vars={"solarMw": {"locked": True, "value": 0}, "windMw": {"locked": True, "value": 0},
              "bessMw": {"locked": True, "value": 0}, "biomassMw": {"min": 0, "max": 300}},
        biomass={"availability": 0.9, "maxPlf": 0.85, "minLoad": 0},
        returnLifetime=True, returnHourly=True,
    )
    res = M.solve(payload)
    assert res["ok"]
    # 80% of 876 GWh from a plant that may run at most 85% of the year
    expected = 0.8 * 100 * M.HOURS / (0.85 * M.HOURS)
    assert res["sizes"]["biomassMw"] == pytest.approx(expected, rel=1e-3)
    assert res["perYear"][0]["dfr"] == pytest.approx(0.8, abs=1e-4)
    assert res["perYear"][0]["biomassMu"] == pytest.approx(0.8 * 100 * M.HOURS / 1000, rel=1e-4)
    life = res["lifetime"]
    assert len(life) == FIN["years"] and life[0]["biomassMwh"] == pytest.approx(700800, rel=1e-4)
    hourly = res["hourly"]
    assert max(hourly["biomass"]) <= 0.9 * res["sizes"]["biomassMw"] + 0.01  # hourly values are rounded to 0.01 MW
    assert sum(hourly["direct"]) == pytest.approx(700800, rel=1e-4)


def test_fuel_cost_raises_the_tariff():
    common = dict(
        vars={"solarMw": {"locked": True, "value": 0}, "windMw": {"locked": True, "value": 0},
              "bessMw": {"locked": True, "value": 0}, "biomassMw": {"min": 0, "max": 300}},
        biomass={"availability": 0.9, "maxPlf": 0.85},
    )
    cheap = M.solve(_payload(fin={**FIN0, "biomassFuelRsPerKwh": 1.0}, **common))
    dear = M.solve(_payload(fin={**FIN0, "biomassFuelRsPerKwh": 4.0}, **common))
    assert dear["tariff"] > cheap["tariff"] + 2.5  # ~Rs 3/kWh of fuel, escalating, passes through


def test_tender_supply_rules_hold_with_a_peak_window():
    peak = ((HOUR >= 18) & (HOUR < 22)).astype(int)
    rules = [
        {"id": "annual", "label": "Annual supply", "basis": "annual", "hours": "all", "target": 0.8},
        {"id": "monthly", "label": "Monthly supply", "basis": "monthly", "hours": "all", "target": 0.7},
        {"id": "peak", "label": "Peak supply", "basis": "monthly", "hours": "peak", "target": 0.9},
    ]
    payload = _payload(
        vars={"solarMw": {"min": 0, "max": 600}, "windMw": {"min": 0, "max": 600}, "bessMw": {"min": 0, "max": 200},
              "biomassMw": {"min": 0, "max": 100}},
        biomass={"availability": 0.9, "maxPlf": 0.8, "minLoad": 0.3},
        compliance=rules, peakMask=peak.tolist(), returnHourly=True,
    )
    res = M.solve(payload)
    assert res["ok"]
    outcomes = {r["id"]: r for r in res["perYear"][0]["rules"]}
    assert set(outcomes) == {"annual", "monthly", "peak"}
    for rule in rules:
        assert outcomes[rule["id"]]["achieved"] >= rule["target"] - 1e-5
    # peak delivery measured from the hourly dispatch agrees with the reported outcome
    h = res["hourly"]
    delivered = np.array(h["direct"]) + np.array(h["discharge"])
    assert delivered[peak == 1].sum() / (100 * peak.sum()) >= 0.9 - 1e-3
    # minimum stable load: a biomass plant that is built runs at least 30% of its size
    if res["sizes"]["biomassMw"] > 1:
        assert min(h["biomass"]) >= 0.3 * res["sizes"]["biomassMw"] - 0.05


def test_round_the_clock_payload_is_unchanged():
    solar, wind, demand = _case()
    payload = {
        "ctx": {"demand": demand.tolist(), "solarCf": solar.tolist(), "windCf": wind.tolist(), "plantMw": 285},
        "bess": BESS0, "costs": COSTS, "fin": {**FIN, "solarDegradation": 0}, "dfrTarget": 0.85, "dfrBasis": "annual",
        "vars": {"solarMw": {"min": 0, "max": 1200}, "windMw": {"min": 0, "max": 900}, "bessMw": {"min": 0, "max": 500}},
        "tariffGuess": 5.5,
    }
    res = M.solve(payload)
    assert set(res["sizes"]) == {"solarMw", "windMw", "bessMw", "bessMwh"}
    assert "lifetime" not in res and "hourly" not in res and "rules" not in res["perYear"][0]


def test_rules_are_validated():
    with pytest.raises(M.LpInputError):
        M.solve(_payload(vars={}, compliance=[{"target": 0.9, "hours": "night"}]))
    with pytest.raises(M.LpInputError):
        M.solve(_payload(vars={}, compliance=[{"target": 0.9, "hours": "peak"}], peakMask=[0] * M.HOURS))


def _market_payload(price_series=None, flat=2.5):
    fin = {**FIN0, "sellSurplus": True, "surplusPrice": flat}
    payload = _payload(
        fin=fin,
        vars={"solarMw": {"locked": True, "value": 300}, "windMw": {"locked": True, "value": 0},
              "bessMw": {"locked": True, "value": 0}, "biomassMw": {"min": 0, "max": 200}},
        biomass={"availability": 0.9, "maxPlf": 0.85},
        returnLifetime=True, returnHourly=True,
    )
    payload["ctx"]["extraExportMw"] = 300
    payload["ctx"]["sellSurplus"] = True
    if price_series is not None:
        payload["ctx"]["surplusPrice"] = list(price_series)
    return payload


def test_constant_market_price_matches_the_flat_price():
    flat = M.solve(_market_payload(flat=2.5))
    series = M.solve(_market_payload(price_series=[2.5] * M.HOURS, flat=0))
    assert series["tariff"] == pytest.approx(flat["tariff"], abs=1e-6)
    assert series["sizes"]["biomassMw"] == pytest.approx(flat["sizes"]["biomassMw"], abs=1e-4)
    life_f, life_s = flat["lifetime"][0], series["lifetime"][0]
    assert life_s["exportRevenueCr"] == pytest.approx(life_f["exportRevenueCr"], rel=1e-6)
    assert life_f["exportRevenueCr"] == pytest.approx(life_f["exportMwh"] * 2.5 * 1e-4, rel=1e-9)


def test_hourly_market_price_values_each_sale_at_its_hour():
    # cheap at midday (solar glut), dear in the evening, as on IEX
    price = np.where((HOUR >= 9) & (HOUR < 16), 1.8, np.where((HOUR >= 18) & (HOUR < 23), 8.0, 4.5))
    res = M.solve(_market_payload(price_series=price.tolist(), flat=0))
    h = res["hourly"]
    assert len(h["price"]) == M.HOURS and h["price"][19] == pytest.approx(8.0)
    exp = np.array(h["export"])
    revenue = 1e-4 * float(exp @ price)
    assert res["lifetime"][0]["exportRevenueCr"] == pytest.approx(revenue, rel=1e-3)
    # at Rs 8 in the evening, against Rs 3.2 of fuel, surplus biomass is sold then rather than at midday
    bio_evening = np.array(h["biomass"])[(HOUR >= 18) & (HOUR < 23)].mean()
    bio_midday = np.array(h["biomass"])[(HOUR >= 9) & (HOUR < 16)].mean()
    assert bio_evening > bio_midday


def test_market_depth_caps_hourly_sales():
    price = np.where((HOUR >= 18) & (HOUR < 23), 8.0, 4.5)
    free = M.solve(_market_payload(price_series=price.tolist(), flat=0))
    cap = np.full(M.HOURS, 20.0)
    payload = _market_payload(price_series=price.tolist(), flat=0)
    payload["ctx"]["surplusCapMw"] = cap.tolist()
    capped = M.solve(payload)
    assert max(capped["hourly"]["export"]) <= 20.0 + 1e-6
    assert max(free["hourly"]["export"]) > 20.0
    assert capped["lifetime"][0]["exportRevenueCr"] < free["lifetime"][0]["exportRevenueCr"]


def _diversion_payload(**extra):
    # wind and biomass free to grow, evening prices far above any PPA tariff
    price = np.where((HOUR >= 18) & (HOUR < 23), 9.0, 2.0)
    payload = _market_payload(price_series=price.tolist(), flat=0)
    payload["vars"] = {"solarMw": {"min": 0, "max": 400}, "windMw": {"min": 0, "max": 400},
                       "bessMw": {"locked": True, "value": 0}, "biomassMw": {"min": 0, "max": 100}}
    payload.update(extra)
    return payload


def test_without_ppa_first_the_optimizer_diverts_ppa_energy_to_the_market():
    res = M.solve(_diversion_payload())
    assert res["perYear"][0]["divertedMu"] > 1.0  # sold at Rs 9 while the PPA had room


def test_ppa_first_sells_only_true_surplus():
    res = M.solve(_diversion_payload(ppaFirst=True))
    assert res["ppaFirst"] is True
    year = res["perYear"][0]
    assert year["divertedMu"] < 0.01, year
    h = res["hourly"]
    delivered = np.array(h["direct"]) + np.array(h["discharge"])
    exported = np.array(h["export"])
    # every hour with a sale has the PPA fully supplied
    assert np.all(delivered[exported > 0.05] >= 100 - 0.05)


def test_solar_only_sales():
    res = M.solve(_diversion_payload(ppaFirst=True, exportSources="solar"))
    h = res["hourly"]
    assert res["exportSources"] == "solar"
    assert np.all(np.array(h["export"]) <= np.array(h["solar"]) + 0.02)


def test_peak_floor_in_any_hour_the_procurer_may_pick():
    rules = [{"id": "peak", "label": "Peak", "basis": "monthly", "hours": "any", "target": 0.9}]
    payload = _payload(
        vars={"solarMw": {"min": 0, "max": 600}, "windMw": {"min": 0, "max": 600}, "bessMw": {"min": 0, "max": 200},
              "biomassMw": {"min": 0, "max": 100}},
        biomass={"availability": 0.9, "maxPlf": 0.8},
        compliance=rules, returnHourly=True,
    )
    res = M.solve(payload)
    delivered = np.array(res["hourly"]["direct"]) + np.array(res["hourly"]["discharge"])
    worst = min(delivered[(M.MONTH_OF_HOUR == m) & (M.HOUR_OF_DAY == h)].mean() / 100 for m in range(12) for h in range(24))
    assert worst >= 0.9 - 1e-4
    assert res["perYear"][0]["rules"][0]["achieved"] == pytest.approx(worst, abs=1e-3)
    # within windows only the window hours are held to the floor
    window = ((HOUR >= 18) & (HOUR < 22)).astype(int)
    res_w = M.solve({**payload, "peakMask": window.tolist()})
    d_w = np.array(res_w["hourly"]["direct"]) + np.array(res_w["hourly"]["discharge"])
    assert min(d_w[(M.MONTH_OF_HOUR == m) & (M.HOUR_OF_DAY == h)].mean() / 100 for m in range(12) for h in range(18, 22)) >= 0.9 - 1e-4


# ---------------------------------------------------------------- hydro and thermal (non-RE)

def _plants_payload(plants, green=None, **vars_extra):
    v = {"solarMw": {"locked": True, "value": 0}, "windMw": {"locked": True, "value": 0},
         "bessMw": {"locked": True, "value": 0}, **vars_extra}
    extra = {"vars": v, "plants": plants, "returnLifetime": True, "returnHourly": True}
    if green is not None:
        extra["greenShareMin"] = green
    return _payload(**extra)


HYDRO = {"id": "hydro", "green": True, "availability": 1.0, "cuf": 0.5, "capexCrPerMw": 0, "fixedLakhPerMw": 150,
         "energyRsPerKwh": 1.0, "escalation": 0}
THERMAL = {"id": "thermal", "green": False, "availability": 0.85, "minLoad": 0, "capexCrPerMw": 0,
           "fixedLakhPerMw": 120, "energyRsPerKwh": 3.0, "recRsPerKwh": 0.2, "escalation": 0}


def test_hydro_alone_is_sized_by_its_cuf():
    res = M.solve(_plants_payload([HYDRO], hydroMw={"min": 0, "max": 400}))
    assert res["ok"]
    # at least 80% of 876 GWh from hydro that may deliver 50% of its capacity over the year:
    # 160 MW at least; any size up to 200 MW costs the same per kWh
    size = res["sizes"]["hydroMw"]
    year = res["perYear"][0]
    assert 160 - 0.2 <= size <= 200 + 0.2
    assert year["dfr"] >= 0.8 - 1e-6
    assert year["hydroMu"] <= 0.5 * size * 8.76 + 0.01
    assert res["lifetime"][0]["hydroMwh"] == pytest.approx(year["hydroMu"] * 1000, rel=1e-3)
    assert max(res["hourly"]["hydro"]) <= res["sizes"]["hydroMw"] + 0.01
    assert res["greenShareMin"] is None  # no non-RE source: nothing to cap


def test_hydro_monthly_cuf_limits_each_month():
    monthly = [0.2] * 5 + [0.9] * 4 + [0.2] * 3  # a monsoon-heavy year
    payload = _plants_payload([{**HYDRO, "cuf": None, "monthlyCuf": monthly}], hydroMw={"min": 0, "max": 2000})
    res = M.solve({**payload, "dfrBasis": "monthly", "dfrTarget": 0.7})
    assert res["ok"]
    hydro = np.array(res["hourly"]["hydro"])
    size = res["sizes"]["hydroMw"]
    for m in range(12):
        mask = M.MONTH_OF_HOUR == m
        assert hydro[mask].sum() <= monthly[m] * size * mask.sum() + 1.0
    # the dry months bind: 70% of the month from hydro at 20% CUF needs 350 MW at least
    assert size >= 0.7 * 100 / 0.2 - 0.5
    assert res["perYear"][0]["minMonthlyDfr"] >= 0.7 - 1e-6


def test_green_share_caps_non_re_supply():
    common = {"windMw": {"min": 0, "max": 600}, "thermalMw": {"min": 0, "max": 200}}
    cheap = {**THERMAL, "fixedLakhPerMw": 20, "energyRsPerKwh": 1.0}  # cheaper than wind: the cap binds
    res = M.solve(_plants_payload([cheap], green=0.51, **common))
    assert res["ok"]
    year = res["perYear"][0]
    assert year["greenShare"] >= 0.51 - 1e-6
    assert year["thermalMu"] <= 0.49 * year["deliveredMu"] + 1e-3
    assert res["greenShareMin"] == 0.51 and res["sizes"]["thermalMw"] > 0
    # without the cap cheap thermal carries more of the supply
    free = M.solve(_plants_payload([cheap], green=0.0, **common))
    assert free["perYear"][0]["thermalMu"] > year["thermalMu"] + 1


def test_non_re_is_never_sold():
    solar, wind, _ = _case()
    payload = _plants_payload([{**THERMAL, "energyRsPerKwh": 0.1, "fixedLakhPerMw": 1, "recRsPerKwh": 0}], green=0.51,
                              windMw={"min": 0, "max": 400}, thermalMw={"min": 0, "max": 300})
    payload["ctx"] = {**payload["ctx"], "sellSurplus": True, "extraExportMw": 300}
    payload["fin"] = {**FIN0, "sellSurplus": True, "surplusPrice": 6.0}
    res = M.solve(payload)
    assert res["ok"]
    h = res["hourly"]
    renewable = np.array(h["solar"]) + np.array(h["wind"]) + np.array(h["biomass"])
    assert np.all(np.array(h["export"]) <= renewable + 0.02)


def test_plants_cost_reaches_the_tariff():
    cheap = M.solve(_plants_payload([{**HYDRO, "energyRsPerKwh": 0.5}], hydroMw={"min": 0, "max": 400}))
    dear = M.solve(_plants_payload([{**HYDRO, "energyRsPerKwh": 2.5}], hydroMw={"min": 0, "max": 400}))
    assert dear["tariff"] == pytest.approx(cheap["tariff"] + 2.0, abs=0.05)  # energy cost passes through


def test_plant_ids_are_checked():
    with pytest.raises(M.LpInputError):
        M.solve(_plants_payload([{**HYDRO, "id": "solar"}], solarMw={"min": 0, "max": 10}))


def test_biomass_ramp_rate_limits_the_hourly_change():
    """A steam plant's ramp rate caps how far its output moves from one hour to the next."""
    common = dict(
        vars={"solarMw": {"locked": True, "value": 150}, "windMw": {"locked": True, "value": 0},
              "bessMw": {"locked": True, "value": 0}, "biomassMw": {"min": 0, "max": 300}},
        returnHourly=True,
    )
    free = M.solve(_payload(biomass={"availability": 0.9, "maxPlf": 0.85, "minLoad": 0}, **common))
    slow = M.solve(_payload(biomass={"availability": 0.9, "maxPlf": 0.85, "minLoad": 0, "rampPerHour": 0.1}, **common))
    step = lambda r: np.abs(np.diff(np.array(r["hourly"]["biomass"]))).max() / r["sizes"]["biomassMw"]
    assert step(free) > 0.15  # without a limit it follows the solar
    assert step(slow) <= 0.1 + 1e-3
    assert slow["perYear"][0]["dfr"] >= 0.8 - 1e-6
