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
