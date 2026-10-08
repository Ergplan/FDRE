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
