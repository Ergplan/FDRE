"""15-minute dispatch of a sized Tender-to-Bid plant (fdre_dispatch15) and the sizing LP's battery rules."""
from __future__ import annotations

import csv
import io
import zipfile

import numpy as np
import pytest

import fdre_dispatch15 as D
import fdre_rtc_lp as M
from tests.test_bid_lp import FIN0, THERMAL, _payload, _plants_payload

pytestmark = pytest.mark.skipif(M.highspy is None, reason="highspy not installed")

HOUR = np.arange(M.HOURS) % 24
RULES = [
    {"id": "annual", "label": "Annual supply", "basis": "annual", "hours": "all", "target": 0.8},
    {"id": "monthly", "label": "Monthly supply", "basis": "monthly", "hours": "all", "target": 0.7},
    {"id": "peak", "label": "Peak supply", "basis": "monthly", "hours": "any", "target": 0.9},
]


def test_split_hourly_keeps_each_hours_energy_and_stays_in_range():
    rng = np.random.default_rng(1)
    v = np.clip(np.sin(np.arange(M.HOURS) / 24 * 2 * np.pi) + rng.normal(0, 0.1, M.HOURS), 0, 1)
    q = D.split_hourly(v, 1.0)
    assert q.shape == (D.BLOCKS,)
    assert np.allclose(q.reshape(-1, 4).mean(axis=1), v)
    assert q.min() >= 0 and q.max() <= 1 + 1e-12
    # a rising hour rises through its blocks
    up = int(np.argmax(np.diff(v)))
    assert np.all(np.diff(q.reshape(-1, 4)[up + 1]) >= 0)
    flat = D.split_hourly(np.full(M.HOURS, 100.0))
    assert np.allclose(flat, 100.0)


def test_net_battery_keeps_charge_and_delivery():
    eta = 0.93
    ch = np.array([300.0, 50.0, 0.0, 200.0])
    dis = np.array([100.0, 200.0, 80.0, 0.0])
    direct = np.array([400.0, 300.0, 20.0, 100.0])
    c2, d2, r2 = M.net_battery(ch, dis, direct, eta)
    assert np.all((c2 < 1e-9) | (d2 < 1e-9))
    assert np.allclose(eta * c2 - d2 / eta, eta * ch - dis / eta)  # same state of charge
    assert np.allclose(r2 + d2, direct + dis)  # same delivery
    assert np.all(r2 + c2 <= direct + ch + 1e-9)  # never needs more generation


def _sized_payload():
    payload = _payload(
        vars={"solarMw": {"min": 0, "max": 600}, "windMw": {"min": 0, "max": 600}, "bessMw": {"min": 0, "max": 200},
              "biomassMw": {"min": 0, "max": 100}},
        biomass={"availability": 0.9, "maxPlf": 0.8, "minLoad": 0.55, "rampPerHour": 0.6},
        compliance=RULES, returnHourly=True,
    )
    return payload


@pytest.fixture(scope="module")
def sized():
    payload = _sized_payload()
    res = M.solve(payload)
    assert res["ok"]
    return payload, res


def test_sizing_hourly_output_never_charges_and_discharges_together(sized):
    _, res = sized
    h = res["hourly"]
    ch, dis = np.array(h["charge"]), np.array(h["discharge"])
    assert not np.any((ch > 0.01) & (dis > 0.01))


def test_fifteen_minute_dispatch_holds_ramp_minimum_and_floors(sized, tmp_path):
    payload, res = sized
    sizes = res["sizes"]
    out = D.run(payload, sizes, res["tariff"], years=[1, 2], zip_path=tmp_path / "d15.zip")
    assert [y["year"] for y in out["years"]] == [1, 2]
    for y in out["years"]:
        assert y["status"] == "Optimal"
        assert y["simultaneousBlocks"] == 0
        bio = y["plants"]["biomass"]
        assert bio["minPct"] >= 0.55 - 1e-6  # technical minimum in every block
        assert bio["maxStepPct"] <= 0.15 + 1e-6  # 0.6 per hour = 15% per 15-minute block
        assert bio["rampPerBlock"] == pytest.approx(0.15)
        for rule in y["rules"]:
            # hourly sizing, 15-minute check: within the hour solar falls faster in later blocks, so
            # the battery's power can bind where the hourly average hid it; a miss is reported
            assert rule["achieved"] >= rule["target"] - 0.005, rule
            assert rule["met"] == (rule["achieved"] >= rule["target"] - 1e-6)
            assert rule["met"] or rule["shortfallMu"] > 0
        assert y["allMet"] == all(r["met"] for r in y["rules"])
    # the 15-minute delivery is close to the hourly sizing's (blocks split each hour's energy)
    assert out["years"][0]["deliveredMu"] == pytest.approx(res["perYear"][0]["deliveredMu"], rel=0.02)
    zf = zipfile.ZipFile(tmp_path / "d15.zip")
    assert set(zf.namelist()) == {"dispatch_15min_year_01.csv", "dispatch_15min_year_02.csv", "summary_by_year.csv", "README.txt", "request.json"}
    rows = list(csv.reader(io.StringIO(zf.read("dispatch_15min_year_01.csv").decode())))
    head, body = rows[0], rows[1:]
    assert len(body) == D.BLOCKS and body[0][4:6] == ["1", "00:00-00:15"] and body[-1][4:6] == ["96", "23:45-00:00"]
    col = {name: head.index(name) for name in head}
    bio = np.array([float(r[col["Biomass output MW"]]) for r in body])
    assert bio.min() >= 0.55 * sizes["biomassMw"] - 0.02
    assert np.abs(np.diff(bio)).max() <= 0.15 * sizes["biomassMw"] + 0.02
    delivered = np.array([float(r[col["Delivered to PPA MW"]]) for r in body])
    assert delivered.mean() * M.HOURS / 1000 == pytest.approx(out["years"][0]["deliveredMu"], rel=1e-4)
    summary = list(csv.reader(io.StringIO(zf.read("summary_by_year.csv").decode())))
    assert [r[0] for r in summary[1:]] == ["1", "2"]


def test_a_floor_the_plant_cannot_meet_is_reported_not_failed(sized):
    payload, res = sized
    small = {**res["sizes"], "bessMw": 0.0, "bessMwh": 0.0, "biomassMw": 0.0}
    out = D.run(payload, small, res["tariff"], years=[1])
    year = out["years"][0]
    assert not year["allMet"] and year["shortfallMu"] > 0
    assert not out["allMet"]


def test_dispatch_requests_are_checked(sized):
    payload, res = sized
    with pytest.raises(D.DispatchError):
        D.run(payload, res["sizes"], 0.0, years=[1])
    with pytest.raises(D.DispatchError):
        D.run(payload, res["sizes"], res["tariff"], years=[99])
    with pytest.raises(D.DispatchError):
        D.start(payload, {**res["sizes"], "solarMw": -5}, res["tariff"])


def test_battery_charges_from_renewables_only_when_thermal_supplies():
    payload = _plants_payload([{**THERMAL, "energyRsPerKwh": 0.5, "fixedLakhPerMw": 5, "recRsPerKwh": 0}], green=0.51,
                              solarMw={"min": 0, "max": 400}, bessMw={"min": 0, "max": 100}, thermalMw={"min": 0, "max": 100})
    res = M.solve(payload)
    assert res["ok"]
    h = res["hourly"]
    renewable = np.array(h["solar"]) + np.array(h["wind"]) + np.array(h["biomass"])
    assert np.all(np.array(h["charge"]) <= renewable + 0.02)
