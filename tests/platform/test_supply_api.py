"""Day 3 gate through the API: profile upload with validation and hashing, supply
configuration validated, reconciled and saved as a scenario input version, then run by the
worker; the engine's own first-year generation reconciles with the loss-chain net energy."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest


def _csv(n=8760, value=0.3, start="2025-01-01 00:00"):
    t0 = datetime.fromisoformat(start)
    return "timestamp,cf\n" + "\n".join(f"{(t0 + timedelta(hours=i)).strftime('%Y-%m-%dT%H:%M')}+05:30,{value}" for i in range(n))


def _setup(client, seed, as_user):
    acme = seed["acme"]
    bidder = as_user("bidder@acme.test")
    tender = client.post(f"/api/v1/orgs/{acme.id}/tenders", json={"name": "T"}, headers=bidder).json()
    scenario = client.post(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/scenarios", json={"name": "S", "inputs": {"settings": {}}}, headers=bidder).json()
    return acme, bidder, tender, scenario


def test_profile_upload_validates_dedupes_and_hashes(client, seed, as_user):
    acme, bidder, _, _ = _setup(client, seed, as_user)
    bad = client.post(
        f"/api/v1/orgs/{acme.id}/profiles", files={"file": ("p.csv", "value\n" + "\n".join(["0.2"] * 100), "text/csv")}, data={"name": "short"}, headers=bidder
    )
    assert bad.status_code == 422 and "timezone" in bad.json()["message"]
    ok = client.post(
        f"/api/v1/orgs/{acme.id}/profiles",
        files={"file": ("solar.csv", _csv(value=0.25), "text/csv")},
        data={
            "name": "Solar P50",
            "technology": "solar",
            "capacity_basis": "mwac",
            "capacity_mw": "100",
            "measured_at": "inverter_ac",
            "p_level": "P50",
            "source": "PVsyst report R1",
        },
        headers=bidder,
    )
    assert ok.status_code == 201, ok.text
    p = ok.json()["profile"]
    assert p["sha256"] and p["stats"]["cuf"] == pytest.approx(0.25) and "05:30" in p["timezone"] and p["resolution_minutes"] == 60
    again = client.post(
        f"/api/v1/orgs/{acme.id}/profiles", files={"file": ("solar-copy.csv", _csv(value=0.25), "text/csv")}, data={"name": "dup"}, headers=bidder
    ).json()
    assert again["profile"]["id"] == p["id"] and again["report"]["duplicate_of"] == p["id"]
    assert client.get(f"/api/v1/orgs/{seed['other'].id}/profiles/{p['id']}", headers=as_user("admin2@other.test")).status_code == 404
    series = client.get(f"/api/v1/orgs/{acme.id}/profiles/{p['id']}?series=true", headers=bidder).json()
    assert len(series["hourly"]) == 8760


def test_supply_config_round_trip_and_engine_reconciliation(client, seed, as_user, worker):
    acme, bidder, tender, scenario = _setup(client, seed, as_user)
    org = acme.id
    p = client.post(
        f"/api/v1/orgs/{org}/profiles",
        files={"file": ("solar.csv", _csv(value=0.3), "text/csv")},
        data={"name": "Solar", "technology": "solar", "capacity_basis": "mwac", "capacity_mw": "100", "measured_at": "inverter_ac"},
        headers=bidder,
    ).json()["profile"]
    solar = client.get(f"/api/v1/orgs/{org}/supply/template/solar?name=Solar%20A&module_id=solar_a", headers=bidder).json()
    solar["profile"] = {
        **solar["profile"],
        "profile_id": p["id"],
        "capacity_basis": "mwac",
        "capacity_mw": 100.0,
        "measured_at": "inverter_ac",
        "synthetic_cuf_percent": None,
    }
    # The uploaded profile is measured at the inverter AC side: DC and inverter stages must be flagged as included.
    bad = client.post(f"/api/v1/orgs/{org}/supply/validate", json={"supply": {"modules": [solar]}}, headers=bidder).json()
    assert bad["ok"] is False and any("counted twice" in e for e in bad["errors"])
    for s in solar["losses"]:
        if s["key"] in ("dc_losses", "inverter_clipping", "inverter_efficiency"):
            s["included_in_profile"] = True
    bess = client.get(f"/api/v1/orgs/{org}/supply/template/bess?name=BESS&module_id=bess_a", headers=bidder).json()
    wind = client.get(f"/api/v1/orgs/{org}/supply/template/wind?name=Wind&module_id=wind_a", headers=bidder).json()
    thermal = client.get(f"/api/v1/orgs/{org}/supply/template/biomass?name=Biomass&module_id=bio_a", headers=bidder).json()
    iex = client.get(f"/api/v1/orgs/{org}/supply/template/iex?name=IEX&module_id=iex_a", headers=bidder).json()
    config = {"nodes": [{"name": "POI", "interconnection_limit_mw": 300}], "modules": [solar, wind, bess, thermal, iex]}
    good = client.post(f"/api/v1/orgs/{org}/supply/validate", json={"supply": config}, headers=bidder).json()
    assert good["ok"] is True, good["errors"]
    recs = {r["module_id"]: r for r in good["reconciliations"]}
    assert recs["solar_a"]["closes"] and recs["wind_a"]["closes"] and recs["bess_a"]["closes"]
    assert [u["kind"] for u in good["unsupported"]] == ["biomass", "iex"]
    assert all(r["model_input"] for rec in good["reconciliations"] for r in rec["rows"])
    assert good["completeness"]["solar_a"]["profile"] == "uploaded" and good["completeness"]["wind_a"]["profile"] == "synthetic"
    # Save as a scenario input version (revision check applies).
    stale = client.put(f"/api/v1/orgs/{org}/scenarios/{scenario['id']}/supply", json={"expected_revision": 0, "supply": config}, headers=bidder)
    assert stale.status_code == 409
    saved = client.put(f"/api/v1/orgs/{org}/scenarios/{scenario['id']}/supply", json={"expected_revision": 1, "supply": config}, headers=bidder).json()
    assert saved["scenario"]["revision"] == 2
    full = client.get(f"/api/v1/orgs/{org}/scenarios/{scenario['id']}", headers=bidder).json()
    inputs = full["current_input_version"]["inputs"]
    assert inputs["profiles"]["solar_a"]["hash"] == p["sha256"] and inputs["profiles"]["wind_a"]["hash"] is None
    gens = {g["name"]: g for g in inputs["project"]["generators"]}
    assert gens["Solar A"]["availability"] == pytest.approx(0.99) and gens["Solar A"]["ac_mw"] == 100 and gens["Solar A"]["dc_mwp"] == 130
    assert inputs["project"]["bess"][0]["usable_mwh_at_poi"] == pytest.approx(170)
    # A run on these inputs: the worker uses the compiled project and the custom profile columns.
    inputs_run = {**inputs, "run_options": {"years_mode": "fast"}}
    inputs_run["project"]["finance"]["hard_compliance_required"] = False
    inputs_run["project"]["tender"]["contracted_capacity_mw"] = 50.0
    client.put(f"/api/v1/orgs/{org}/scenarios/{scenario['id']}/inputs", json={"expected_revision": 2, "inputs": inputs_run}, headers=bidder)
    run = client.post(f"/api/v1/orgs/{org}/scenarios/{scenario['id']}/runs", json={"kind": "evaluate"}, headers=bidder).json()
    assert run["snapshot"]["profile_hashes"]["solar_a"] == p["sha256"]
    assert worker.run_once()
    done = client.get(f"/api/v1/orgs/{org}/runs/{run['id']}", headers=bidder).json()
    assert done["status"] in ("succeeded", "infeasible"), done["error"]
    # Independent reconciliation: the engine's first-year solar generation equals the chain's energy before evacuation.
    first_year = done["result"]["first_year"]
    solar_rec = recs["solar_a"]
    engine_solar_mwh = first_year["generation_by_asset"]["Solar A"]
    before_evacuation = solar_rec["rows"][-1]["energy_in_mwh"]
    assert engine_solar_mwh == pytest.approx(before_evacuation, rel=1e-3)
    engine_wind_mwh = first_year["generation_by_asset"]["Wind"]
    assert engine_wind_mwh == pytest.approx(recs["wind_a"]["rows"][-1]["energy_in_mwh"], rel=1e-3)
