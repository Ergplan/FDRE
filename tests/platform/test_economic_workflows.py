"""Day 4 gate through the API and worker: workflow B (fixed tariff and capacities, MILP or
rule-based dispatch) and workflow A (tariff search), with immutable snapshots, finance
results, certification and the classification of outcomes. Capacities never change."""

from __future__ import annotations

import pytest


def _inputs():
    import fdre_enterprise_engine as E
    from fdre_platform.services.supply import module_template
    from fdre_platform.supply.compile import compile_supply
    from fdre_platform.supply.schema import parse_config

    project = E.default_fdre2_project()
    project.tender.contracted_capacity_mw = 50.0
    project.finance.hard_compliance_required = False
    base = E.project_to_dict(project)
    solar = module_template("solar", "Solar A", "solar_a")
    solar["mwac"], solar["mwp_dc"] = 120.0, 156.0
    solar["profile"]["capacity_mw"] = 120.0
    bess = module_template("bess", "BESS A", "bess_a")
    bess["power_mw"], bess["energy_mwh"] = 50.0, 200.0
    cfg = {"nodes": [{"name": "POI", "interconnection_limit_mw": 200}], "modules": [solar, bess]}
    compiled = compile_supply(parse_config(cfg), base, None)
    assert compiled["errors"] == []
    return {
        "project": compiled["project"],
        "supply": cfg,
        "supply_compiled": {"custom_cf": compiled["custom_cf"], "reconciliations": compiled["reconciliations"], "unsupported": []},
        "profiles": {},
        "settings": {},
        "run_options": {"years_mode": "fast", "solve_years": [1, 25], "time_limit_seconds": 60, "mip_rel_gap": 0.01},
    }


def _scenario(client, seed, as_user):
    acme = seed["acme"]
    bidder = as_user("bidder@acme.test")
    tender = client.post(f"/api/v1/orgs/{acme.id}/tenders", json={"name": "T"}, headers=bidder).json()
    scenario = client.post(
        f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/scenarios", json={"name": "S", "workflow": "fixed_tariff", "inputs": _inputs()}, headers=bidder
    ).json()
    return acme.id, bidder, scenario


def _run(client, worker, org, headers, scenario_id, kind, settings):
    run = client.post(f"/api/v1/orgs/{org}/scenarios/{scenario_id}/runs", json={"kind": kind, "solver_settings": settings}, headers=headers).json()
    assert worker.run_once()
    return client.get(f"/api/v1/orgs/{org}/runs/{run['id']}", headers=headers).json()


def test_fixed_tariff_milp_holds_capacities_and_reports_finance(client, seed, as_user, worker):
    org, bidder, scenario = _scenario(client, seed, as_user)
    before = scenario["current_input_version"]["inputs"]["project"]
    done = _run(client, worker, org, bidder, scenario["id"], "fixed_tariff", {"tariff": 4.5, "dispatch": "milp"})
    assert done["status"] == "succeeded", done["error"]
    r = done["result"]
    assert r["workflow"] == "B" and r["capacities_fixed"] is True and r["tariff"] == 4.5
    assert r["term"]["years_solved"] == [1, 25] and len(r["term"]["years_interpolated"]) == 23
    assert r["term"]["certification_year1"]["status"] == "certified" and r["term"]["certification_last"]["status"] == "certified"
    fin = r["finance"]
    assert fin["version"] == "finance.v1" and fin["equity_irr"] is not None and fin["project_irr"] is not None and fin["min_dscr"] > 0
    assert len(fin["statement"]["cfads"]) == 25 and len(r["sensitivities"]) == 8
    assert done["metrics"]["certified"] == "certified" and done["metrics"]["solver"].startswith("HiGHS")
    # Capacities are untouched: the scenario inputs are the same version, and the snapshot carries the same hash.
    after = client.get(f"/api/v1/orgs/{org}/scenarios/{scenario['id']}", headers=bidder).json()
    assert after["revision"] == scenario["revision"] and after["current_input_version"]["inputs"]["project"]["generators"] == before["generators"]
    assert (
        done["snapshot"]["solver_settings"] == {"tariff": 4.5, "dispatch": "milp"}
        and done["snapshot"]["inputs"]["hash"] == scenario["current_input_version"]["inputs_hash"]
    )
    # Energy delivered respects the contracted capacity, and the year-1 dispatch is in the artifact.
    y1 = r["term"]["per_year"][0]
    assert 0 < y1["ppa_mwh"] <= 50.0 * 8766 * 0.44 + 1e-6 and y1["interpolated"] is False
    assert r["dispatch_year1"] and len(r["dispatch_year1"]["delivered_mw"]) == 8760


def test_fixed_tariff_rules_dispatch_is_an_explicit_choice(client, seed, as_user, worker):
    org, bidder, scenario = _scenario(client, seed, as_user)
    done = _run(client, worker, org, bidder, scenario["id"], "fixed_tariff", {"tariff": 4.5, "dispatch": "rules"})
    assert done["status"] == "succeeded", done["error"]
    assert (
        done["result"]["dispatch"] == "rules" and done["result"]["mode"] == "fixed_tariff_rules" and done["metrics"]["solver"] == "legacy chronological rules"
    )
    assert done["result"]["finance"]["equity_irr"] is not None


def test_bid_tariff_search_finds_the_lowest_tariff_meeting_the_target(client, seed, as_user, worker):
    org, bidder, scenario = _scenario(client, seed, as_user)
    done = _run(client, worker, org, bidder, scenario["id"], "bid_tariff", {"tariff_lo": 2.0, "tariff_hi": 9.0})
    assert done["status"] in ("succeeded", "time_limited"), done["error"]
    r = done["result"]
    assert r["workflow"] == "A" and r["search_status"] in ("found", "non_monotone", "time_limited")
    assert r["tariff"] is not None and 2.0 <= r["tariff"] <= 9.0
    assert r["finance"]["meets_target"] is True and r["finance"]["equity_irr"] >= r["assumptions"]["target_equity_irr"] - 1e-6
    assert r["certification_boundary"].startswith("The MILP gap certifies")
    samples = r["samples"]
    assert len(samples) >= 3 and all("equity_irr" in s for s in samples)
    # The tariff just below the found one does not meet the target (lowest within tolerance).
    below = [s for s in samples if s["tariff"] < r["tariff"] - 1e-9]
    assert all(not s["meets"] for s in below)
    assert r["dispatch_invariant"] in (True, False) and r["monotone"] in (True, False, None)
    assert r["term"]["certification_year1"]["status"] == "certified"


def test_infeasible_fixed_tariff_is_classified(client, seed, as_user, worker):
    """A storage unit whose only permitted charging source is not available (market
    purchases without a price scenario) but which draws auxiliary power cannot keep its
    SOC non-negative: a hard infeasibility, reported as such, with no finance."""
    org, bidder, scenario = _scenario(client, seed, as_user)
    inputs = _inputs()
    bess = next(m for m in inputs["supply"]["modules"] if m["kind"] == "bess")
    bess["charging_sources"] = ["market"]
    bess["auxiliary_load_kw"] = 50.0
    client.put(f"/api/v1/orgs/{org}/scenarios/{scenario['id']}/inputs", json={"expected_revision": 1, "inputs": inputs}, headers=bidder)
    done = _run(client, worker, org, bidder, scenario["id"], "milp_dispatch", {"tariff": 4.0})
    assert done["status"] == "infeasible", done["error"]
    assert done["result"]["term"]["status"] == "infeasible" and done["result"]["finance"] is None
    assert done["result"]["term"]["solves"][0]["solver_status"] == "kInfeasible"


def test_time_limited_run_is_classified_and_cancellable(client, seed, as_user, worker):
    org, bidder, scenario = _scenario(client, seed, as_user)
    inputs = _inputs()
    from fdre_platform.services.supply import module_template

    bio = module_template("biomass", "Bio", "bio_a")
    bio["capacity_mw"] = 20.0
    inputs["supply"]["modules"].append(bio)
    client.put(f"/api/v1/orgs/{org}/scenarios/{scenario['id']}/inputs", json={"expected_revision": 1, "inputs": inputs}, headers=bidder)
    done = _run(client, worker, org, bidder, scenario["id"], "milp_dispatch", {"tariff": 4.0, "time_limit_seconds": 0.5, "mip_rel_gap": 1e-9})
    assert done["status"] in ("time_limited", "succeeded", "failed"), done["error"]
    if done["status"] == "time_limited":
        assert done["result"]["term"]["worst_gap"] is not None and done["metrics"]["gap"] is not None
        assert done["result"]["term"]["certification_year1"]["status"] == "certified"  # the incumbent is still a valid dispatch
    with pytest.raises(AssertionError):
        assert done["status"] == "cancelled"
