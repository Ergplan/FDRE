"""Day 3 gate (unit level): invalid profiles, incompatible units and duplicate losses are
rejected; every displayed loss maps to a model input; gross-to-net reconciles."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from fdre_platform.supply import losses, profiles
from fdre_platform.supply.compile import ProfileStore, compile_supply
from fdre_platform.supply.schema import BessModule, LossStage, ProfileRef, SolarModule, SupplyConfig, ThermalModule, WindModule, default_losses, parse_config


def _series(start="2025-01-01 00:00", n=8760, step=60, value=0.3, tz="+05:30"):
    t0 = datetime.fromisoformat(start)
    return "timestamp,cf\n" + "\n".join(f"{(t0 + timedelta(minutes=i * step)).strftime('%Y-%m-%dT%H:%M')}{tz},{value}" for i in range(n))


def test_profile_requires_timezone_and_full_year():
    r = profiles.validate("value\n" + "\n".join(["0.2"] * 8760))
    assert not r.ok and any("timezone" in e for e in r.errors)
    r = profiles.validate("value\n" + "\n".join(["0.2"] * 8000), timezone="Asia/Kolkata")
    assert not r.ok and any("8760" in e for e in r.errors)
    r = profiles.validate("value\n" + "\n".join(["0.2"] * 8760), timezone="Asia/Kolkata")
    assert r.ok and r.sha256 and r.stats["cuf"] == pytest.approx(0.2) and r.resolution_minutes == 60


def test_profile_detects_duplicates_missing_and_interval_mismatch():
    text = _series()
    lines = text.splitlines()
    dup = "\n".join(lines[:100] + [lines[99]] + lines[100:])
    r = profiles.validate(dup, timezone="Asia/Kolkata")
    assert any("duplicate" in e for e in r.errors)
    gap = "\n".join(lines[:100] + lines[103:])
    r = profiles.validate(gap, timezone="Asia/Kolkata")
    assert r.missing_intervals == 3 and any("missing" in e for e in r.errors)
    r = profiles.validate(text, timezone="Asia/Kolkata", interval_minutes=15)
    assert any("declared interval 15" in e for e in r.errors)


def test_profile_leap_year_and_fifteen_minute_normalisation():
    leap = _series(start="2024-01-01 00:00", n=8784)
    r = profiles.validate(leap, timezone="Asia/Kolkata")
    assert r.ok and "29 February" in (r.leap_day_handling or "") and len(r.hourly) == 8760
    quarter = _series(n=35040, step=15, value=0.25)
    r = profiles.validate(quarter, timezone="Asia/Kolkata")
    assert r.ok and r.resolution_minutes == 15 and len(r.hourly) == 8760 and r.stats["cuf"] == pytest.approx(0.25)


def test_profile_physical_bounds_and_mw_basis():
    r = profiles.validate("value\n" + "\n".join(["1.5"] * 8760), timezone="UTC")
    assert not r.ok and any("above the capacity" in e for e in r.errors)
    r = profiles.validate("value\n" + "\n".join(["-0.1"] * 8760), timezone="UTC")
    assert not r.ok and any("negative" in e for e in r.errors)
    r = profiles.validate("mw\n" + "\n".join(["50"] * 8760), timezone="UTC", basis="mw")
    assert not r.ok and any("capacity_mw" in e for e in r.errors)
    r = profiles.validate("mw\n" + "\n".join(["50"] * 8760), timezone="UTC", basis="mw", capacity_mw=100)
    assert r.ok and r.stats["cuf"] == pytest.approx(0.5)
    scaled, lost = profiles.scale_to_cuf([0.9, 0.9, 0.0, 0.0], 0.6)
    assert max(scaled) <= 1.0 and lost > 0  # scaling cannot push a capacity factor above 1


def test_loss_chain_reconciles_and_maps_every_stage():
    stages = default_losses("solar")
    hourly = [0.5] * 8760
    rec = losses.apply_chain(
        hourly, 100.0, stages, module_id="s1", module_name="Solar A", kind="solar", capacity_basis="mwac", profile=ProfileRef(synthetic_cuf_percent=50)
    )
    assert rec.errors == [] and rec.closes
    gross = 0.5 * 100 * 8760
    expected_net = gross * 0.97 * 0.985 * 0.98 * 0.99 * 0.995
    assert rec.gross_mwh == pytest.approx(gross) and rec.net_mwh == pytest.approx(expected_net)
    assert all(r.model_input in losses.MODEL_INPUTS for r in rec.rows)
    assert (
        rec.profile_multiplier == pytest.approx(0.97 * 0.985 * 0.98)
        and rec.availability_factor == pytest.approx(0.99)
        and rec.transmission_loss_percent == pytest.approx(0.5)
    )
    # Independent check: engine-side energy = cf x ac_mw x availability over the year equals the chain's energy before evacuation.
    engine_side = sum(v * rec.profile_multiplier for v in hourly) * 100 * rec.availability_factor
    assert engine_side == pytest.approx(rec.rows[-1].energy_in_mwh)


def test_duplicate_and_double_counted_losses_are_rejected():
    with pytest.raises(ValueError, match="duplicate loss stage"):
        SolarModule(
            id="s",
            name="S",
            mwp_dc=130,
            mwac=100,
            losses=[LossStage(key="x", label="x", kind="percent", value=1, boundary="poi", model_input="profile_multiplier")] * 2,
        )
    with pytest.raises(ValueError, match="boundary order"):
        SolarModule(
            id="s",
            name="S",
            mwp_dc=130,
            mwac=100,
            losses=[
                LossStage(key="a", label="a", kind="percent", value=1, boundary="poi", model_input="profile_multiplier"),
                LossStage(key="b", label="b", kind="percent", value=1, boundary="dc_terminals", model_input="profile_multiplier"),
            ],
        )
    # A DC loss on a profile measured at the inverter AC side is already inside the profile.
    stages = default_losses("solar")
    errors, _ = losses.validate_stages(stages, ProfileRef(profile_id="p1", measured_at="inverter_ac"))
    assert any("counted twice" in e and "dc_losses" in e for e in errors)
    stages[0] = stages[0].model_copy(update={"included_in_profile": True})
    stages[1] = stages[1].model_copy(update={"included_in_profile": True})
    stages[2] = stages[2].model_copy(update={"included_in_profile": True})
    errors, _ = losses.validate_stages(stages, ProfileRef(profile_id="p1", measured_at="inverter_ac"))
    assert errors == []
    rec = losses.apply_chain(
        [0.4] * 8760,
        100.0,
        stages,
        module_id="s",
        module_name="S",
        kind="solar",
        capacity_basis="mwac",
        profile=ProfileRef(profile_id="p1", measured_at="inverter_ac"),
    )
    assert [r.applied for r in rec.rows][:3] == [False, False, False] and rec.closes
    bad = [LossStage(key="k", label="k", kind="percent", value=1, boundary="poi", model_input="not.a.model.input")]
    errors, _ = losses.validate_stages(bad, None)
    assert any("no model input" in e for e in errors)
    two_avail = default_losses("wind") + [
        LossStage(key="availability2", label="second", kind="availability", value=99, boundary="poi", model_input="generator.availability")
    ]
    errors, _ = losses.validate_stages(two_avail, None)
    assert any("more than one availability" in e for e in errors)


def test_incompatible_profile_units_are_rejected_and_dc_basis_is_converted():
    store = ProfileStore(
        lambda pid: (
            {"hourly": [0.5] * 8760, "capacity_basis": "installed_mw", "sha256": "abc"}
            if pid == "wind-basis"
            else {"hourly": [0.6] * 8760, "capacity_basis": "mwp_dc", "sha256": "dc"}
            if pid == "dc"
            else None
        )
    )
    cfg = SupplyConfig(
        modules=[SolarModule(id="s", name="S", mwp_dc=130, mwac=100, profile=ProfileRef(profile_id="wind-basis", capacity_basis="installed_mw"), losses=[])]
    )
    out = compile_supply(cfg, {"tender": {}, "finance": {}}, store)
    assert any("incompatible units" in e for e in out["errors"]) and out["project"]["generators"] == []
    cfg = SupplyConfig(
        modules=[
            SolarModule(
                id="s",
                name="S",
                mwp_dc=130,
                mwac=100,
                profile=ProfileRef(profile_id="dc", capacity_basis="mwp_dc", capacity_mw=130, measured_at="dc_terminals"),
                losses=[st for st in default_losses("solar")],
            )
        ]
    )
    out = compile_supply(cfg, {"tender": {}, "finance": {}}, store)
    assert out["errors"] == []
    gen = out["project"]["generators"][0]
    assert gen["ac_mw"] == 100 and gen["dc_mwp"] == 130
    # 0.6 on 130 MWp -> 0.78 on 100 MWac before losses; chain reconciles.
    rec = out["reconciliations"][0]
    assert rec["cuf_gross"] == pytest.approx(0.78) and rec["closes"]


def test_thermal_and_bess_schemas_validate_units():
    with pytest.raises(ValueError, match="exactly one of heat_rate"):
        ThermalModule(
            id="t",
            name="T",
            capacity_mw=100,
            min_stable_generation_percent=40,
            ramp_up_mw_per_min=2,
            ramp_down_mw_per_min=2,
            min_up_time_h=4,
            min_down_time_h=4,
            startup_cost_inr=1e6,
            startup_time_h=2,
            planned_outage_percent=5,
            forced_outage_percent=3,
            auxiliary_consumption_percent=8,
            variable_om_inr_per_mwh=300,
            fixed_om_inr_per_mw_year=1e6,
            fuel={"calorific_value_kcal_per_kg": 4000, "price_inr_per_tonne": 3000},
        )
    t = ThermalModule(
        id="t",
        name="T",
        capacity_mw=100,
        min_stable_generation_percent=40,
        ramp_up_mw_per_min=2,
        ramp_down_mw_per_min=2,
        min_up_time_h=4,
        min_down_time_h=4,
        startup_cost_inr=1e6,
        startup_time_h=2,
        planned_outage_percent=5,
        forced_outage_percent=3,
        efficiency_percent=36,
        auxiliary_consumption_percent=8,
        variable_om_inr_per_mwh=300,
        fixed_om_inr_per_mw_year=1e6,
        fuel={"calorific_value_kcal_per_kg": 4000, "price_inr_per_tonne": 3000},
        losses=default_losses("thermal"),
    )
    assert t.heat_rate == pytest.approx(860 / 0.36)
    with pytest.raises(ValueError, match="soc_min_percent"):
        BessModule(
            id="b",
            name="B",
            power_mw=50,
            energy_mwh=200,
            soc_min_percent=90,
            soc_max_percent=10,
            charge_efficiency_percent=95,
            discharge_efficiency_percent=95,
            calendar_degradation_percent_per_year=2,
            cycle_degradation_percent_per_cycle=0.005,
            availability_percent=98,
        )
    b = BessModule(
        id="b",
        name="B",
        power_mw=50,
        energy_mwh=200,
        soc_min_percent=10,
        soc_max_percent=95,
        charge_efficiency_percent=95,
        discharge_efficiency_percent=95,
        calendar_degradation_percent_per_year=2,
        cycle_degradation_percent_per_cycle=0.005,
        availability_percent=98,
        losses=default_losses("bess"),
    )
    assert b.usable_mwh == pytest.approx(170) and b.round_trip_efficiency == pytest.approx(0.9025)
    cfg = parse_config(
        {
            "modules": [
                t.model_dump(),
                b.model_dump(),
                WindModule(id="w", name="W", installed_mw=60, profile=ProfileRef(synthetic_cuf_percent=32), losses=default_losses("wind")).model_dump(),
            ]
        }
    )
    out = compile_supply(cfg, {"tender": {}, "finance": {}}, None)
    assert out["errors"] == []
    assert [u["kind"] for u in out["unsupported"]] == ["thermal"]
    assert out["project"]["bess"][0]["usable_mwh_at_poi"] == pytest.approx(170) and out["project"]["bess"][0]["rte"] == pytest.approx(0.9025)
    assert out["project"]["generators"][0]["technology"] == "wind" and abs(out["project"]["generators"][0]["cuf"] - 0.32) < 0.01
    assert out["project"]["finance"]["transmission_loss_percent"] == pytest.approx(0.5)
