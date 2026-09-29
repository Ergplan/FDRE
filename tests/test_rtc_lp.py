"""Round-the-clock sizing LP (fdre_rtc_lp.py): years, finance weights and a small solve."""
from __future__ import annotations

import math

import numpy as np
import pytest

import fdre_rtc_lp as M

FIN = {
    "years": 25, "targetEquityIrr": 0.14, "debtFraction": 0.7, "interestRate": 0.09, "tenorYears": 15,
    "repayment": "equal", "taxRate": 0.2517, "taxDepreciation": "wdv", "wdvRate": 0.4, "bookLifeYears": 25,
    "salvagePct": 0.1, "solarOmLakhPerMw": 4.0, "windOmLakhPerMw": 9.0, "bessOmLakhPerMwh": 1.2,
    "omEscalation": 0.05, "insurancePct": 0.003, "otherFixedCr": 0, "receivableDays": 45, "sellSurplus": False,
    "surplusPrice": 2.5, "tariffEscalation": 0, "solarDegradation": 0.005, "windDegradation": 0, "demandGrowth": 0,
}
BESS = {"rte": 0.87, "minSoc": 0.05, "maxSoc": 0.95, "initSoc": 0.5, "annualDegradation": 0.02,
        "augmentation": "annual", "augmentationYear": 12, "costDeclinePct": 0.03, "durationH": 4}
COSTS = {"solarCrPerMw": 3.5, "windCrPerMw": 6.5, "bessCrPerMwh": 1.2, "bessPcsCrPerMw": 0, "evacuationCr": 0, "preopPct": 0.05}


def test_representative_years():
    assert M.representative_years(FIN, BESS) == [1, 25]  # annual top-ups: year 25 binds
    assert M.representative_years(FIN, {**BESS, "augmentation": "oneTime"}) == [1, 11, 12, 25]
    flat = {**FIN, "solarDegradation": 0}
    assert M.representative_years(flat, {**BESS, "annualDegradation": 0}) == [1]
    assert M.representative_years(FIN, BESS, "all") == list(range(1, 26))
    w = M.interpolation_weights([1, 25], 25)
    assert np.allclose(w.sum(axis=1), 1) and w[12, 0] == pytest.approx(0.5)


def test_tax_timing_carries_losses_forward():
    taxable = np.array([0, -10, -5, 4, 6, 8, 3] + [5] * 19, float)
    z = M.tax_timing(FIN, taxable)
    # the 15 of losses are used up in year 5 (4 + 6 + 8 >= 15), so tax on years 1-5 lands in year 5
    assert list(z[1:6]) == [5, 5, 5, 5, 5] and z[6] == 6
    assert list(M.tax_timing(FIN, None)[1:4]) == [1, 2, 3]


def test_tariff_weights_reduce_to_discounting():
    fin = {**FIN, "taxRate": 0, "debtFraction": 0, "receivableDays": 0, "salvagePct": 0}
    tw = M.tariff_weights(fin)
    v = np.array([1.14 ** -y for y in range(1, 26)])
    assert tw["capex"] == pytest.approx(1.0)
    assert np.allclose(tw["rev"][1:], v) and np.allclose(tw["opex"][1:], v) and np.allclose(tw["aug"][1:], v)


def _case(seed=5):
    rng = np.random.default_rng(seed)
    h = np.arange(M.HOURS) % 24
    day = np.arange(M.HOURS) // 24
    solar = np.clip(np.sin((h - 6) / 12 * math.pi), 0, None) * (0.9 + 0.1 * np.cos(day / 365 * 2 * math.pi))
    solar *= 0.24 / solar.mean()
    wind = np.clip(0.33 + 0.25 * np.sin(day / 365 * 2 * math.pi) + 0.2 * np.sin(h / 24 * 2 * math.pi + 2) + rng.normal(0, 0.12, M.HOURS), 0, 1)
    demand = np.full(M.HOURS, 2455e3 / M.HOURS)
    return solar, wind, demand


def _greedy_dfr(solar, wind, demand, plant, sizes, bess):
    """The browser engine's dispatch rule (simulate() in engine.js), year 1."""
    eta = math.sqrt(bess["rte"])
    E = sizes["bessMwh"]
    lo, hi = E * bess["minSoc"], E * bess["maxSoc"]
    soc = min(hi, max(lo, E * bess["initSoc"]))
    delivered = 0.0
    for t in range(M.HOURS):
        target = min(demand[t], plant)
        g = sizes["solarMw"] * solar[t] + sizes["windMw"] * wind[t]
        direct = min(g, target)
        ch = max(0.0, min(g - direct, sizes["bessMw"], (hi - soc) / eta))
        soc += ch * eta
        dis = max(0.0, min(target - direct, sizes["bessMw"], (soc - lo) * eta))
        soc -= dis / eta
        delivered += direct + dis
    return delivered / demand.sum()


@pytest.mark.skipif(M.highspy is None, reason="highspy not installed")
def test_lp_meets_dfr_and_matches_engine_dispatch():
    solar, wind, demand = _case()
    fin = {**FIN, "solarDegradation": 0}
    bess = {**BESS, "annualDegradation": 0}
    payload = {
        "ctx": {"demand": demand.tolist(), "solarCf": solar.tolist(), "windCf": wind.tolist(), "plantMw": 285},
        "bess": bess, "costs": COSTS, "fin": fin, "dfrTarget": 0.85, "dfrBasis": "annual",
        "vars": {"solarMw": {"min": 0, "max": 1200}, "windMw": {"min": 0, "max": 900}, "bessMw": {"min": 0, "max": 500}},
        "tariffGuess": 5.5,
    }
    lines = []
    res = M.solve(payload, on_log=lines.append)
    assert res["ok"], res.get("status")
    assert res["years"] == [1]
    assert res["perYear"][0]["dfr"] >= 0.85 - 1e-6
    assert res["lowerBound"] <= res["tariff"] + 1e-9 and res["tariff"] - res["lowerBound"] < 0.01
    assert any(line["stage"] == "highs-log" for line in lines), "HiGHS output is streamed"
    # the engine's greedy dispatch reaches the same DFR with the LP's sizes
    assert _greedy_dfr(solar, wind, demand, 285, res["sizes"], bess) == pytest.approx(res["perYear"][0]["dfr"], abs=0.003)
    # and 5% less of everything cannot meet the target: the answer is not oversized
    smaller = {k: v * 0.95 for k, v in res["sizes"].items()}
    assert _greedy_dfr(solar, wind, demand, 285, smaller, bess) < 0.85
