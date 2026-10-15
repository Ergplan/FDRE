"""Profiles and supply configurations: store validated profiles once (hash), validate and
reconcile a supply configuration, save it into a scenario's inputs as a new version, and
compile it into the engine inputs a run uses."""

from __future__ import annotations

import hashlib
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from fdre_platform.models import Profile, Scenario
from fdre_platform.storage import LocalStorage
from fdre_platform.supply import profiles as profile_lib
from fdre_platform.supply.compile import ProfileStore, compile_supply
from fdre_platform.supply.schema import FIELD_META, SupplyConfig, default_losses, parse_config

from . import audit, scenarios
from .context import Actor
from .tenders import NotFound, ValidationFailed


def store_profile(
    session: Session, storage: LocalStorage, actor: Actor, *, name: str, filename: str, data: bytes, kind: str = "generation", technology: str | None = None,
    basis: str = "capacity_factor", capacity_basis: str | None = None, capacity_mw: float | None = None, measured_at: str | None = None, p_level: str | None = None,
    timezone: str | None = None, interval_minutes: int | None = None, start: str | None = None, leap_day: str = "drop", provenance: dict[str, Any] | None = None, note: str = "",
) -> tuple[Profile, dict[str, Any]]:
    actor.require("scenario.edit")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValidationFailed("profile must be a UTF-8 CSV") from exc
    report = profile_lib.validate(text, basis=basis, timezone=timezone, interval_minutes=interval_minutes, start=start, leap_day=leap_day, capacity_mw=capacity_mw)
    if not report.ok:
        raise ValidationFailed("profile rejected: " + "; ".join(report.errors))
    assert report.sha256 and report.hourly is not None
    existing = session.scalar(select(Profile).where(Profile.organization_id == actor.organization_id, Profile.sha256 == report.sha256))
    if existing is not None:
        return existing, {**profile_lib.describe(report), "duplicate_of": existing.id}
    stored = storage.put(actor.organization_id, "profiles", filename, data)
    profile = Profile(
        organization_id=actor.organization_id, name=name.strip() or filename, kind=kind, technology=technology, basis=basis, capacity_basis=capacity_basis, capacity_mw=capacity_mw,
        measured_at=measured_at, p_level=p_level, timezone=report.timezone or "", resolution_minutes=report.resolution_minutes or 60, year=report.year, sha256=report.sha256,
        source_sha256=hashlib.sha256(data).hexdigest(), storage_key=stored.key, hourly=report.hourly, stats=report.stats, report=profile_lib.describe(report), provenance=provenance or {}, note=note, created_by=actor.user_id,
    )
    session.add(profile)
    session.flush()
    audit.record(session, actor, "profile.create", "profile", profile.id, after={"name": profile.name, "sha256": profile.sha256, "basis": basis, "capacity_basis": capacity_basis, "capacity_mw": capacity_mw, "resolution_minutes": profile.resolution_minutes, "timezone": profile.timezone, "stats": profile.stats, "warnings": report.warnings})
    return profile, profile_lib.describe(report)


def list_profiles(session: Session, actor: Actor) -> list[Profile]:
    return list(session.scalars(select(Profile).where(Profile.organization_id == actor.organization_id).order_by(Profile.created_at.desc())))


def get_profile(session: Session, actor: Actor, profile_id: str) -> Profile:
    p = session.get(Profile, profile_id)
    if p is None or p.organization_id != actor.organization_id:
        raise NotFound("profile")
    return p


def profile_store(session: Session, actor: Actor) -> ProfileStore:
    def lookup(profile_id: str) -> dict[str, Any] | None:
        p = session.get(Profile, profile_id)
        if p is None or p.organization_id != actor.organization_id:
            return None
        return {"hourly": p.hourly, "basis": p.basis, "capacity_basis": p.capacity_basis, "capacity_mw": p.capacity_mw, "sha256": p.sha256, "cuf": p.stats.get("cuf"), "measured_at": p.measured_at}

    return ProfileStore(lookup)


def validate_config(session: Session, actor: Actor, data: dict[str, Any], base_project: dict[str, Any] | None = None) -> dict[str, Any]:
    """Validate and reconcile without saving. Schema errors are reported as such."""
    try:
        config = parse_config(data)
    except Exception as exc:  # pydantic ValidationError or ValueError
        return {"ok": False, "schema_errors": [str(exc)], "reconciliations": [], "unsupported": [], "errors": [], "completeness": {}}
    base = base_project or _default_project()
    out = compile_supply(config, base, profile_store(session, actor))
    completeness = {m.id: _completeness(m) for m in config.modules}
    return {"ok": not out["errors"], "schema_errors": [], "completeness": completeness, **{k: v for k, v in out.items() if k != "custom_cf"}, "custom_cf_columns": sorted(out["custom_cf"])}


def _completeness(module) -> dict[str, Any]:
    meta = FIELD_META.get(module.kind, [])
    missing = []
    defaulted = []
    for f in meta:
        value = module
        for part in f["field"].split("."):
            value = getattr(value, part, None) if value is not None else None
        if value is None:
            missing.append(f["field"])
    for s in module.losses:
        if s.provenance.kind == "defaulted":
            defaulted.append(s.key)
    if module.kind in ("solar", "wind") and not module.profile.profile_id and module.profile.synthetic_cuf_percent is None:
        missing.append("profile")
    total = len(meta) + 1
    return {"missing": missing, "defaulted_losses": defaulted, "score": round(1 - len(missing) / max(total, 1), 2), "profile": "uploaded" if getattr(getattr(module, "profile", None), "profile_id", None) else ("synthetic" if getattr(getattr(module, "profile", None), "synthetic_cuf_percent", None) is not None else "none")}


def save_config(session: Session, actor: Actor, scenario_id: str, *, expected_revision: int, data: dict[str, Any], note: str = "") -> tuple[Scenario, dict[str, Any]]:
    """Validate, reconcile and store as inputs.supply plus the compiled engine project and
    profile hashes, as a new input version (revision check as any save)."""
    result = validate_config(session, actor, data)
    if result["schema_errors"]:
        raise ValidationFailed("supply configuration invalid: " + "; ".join(result["schema_errors"]))
    if result["errors"]:
        raise ValidationFailed("supply configuration rejected: " + "; ".join(result["errors"]))
    scenario = scenarios.get(session, actor, scenario_id)
    current = scenarios.current_inputs(session, scenario)
    inputs = dict(current.inputs) if current else {}
    base_project = inputs.get("project") or _default_project()
    compiled = compile_supply(parse_config(data), base_project, profile_store(session, actor))
    inputs["supply"] = data
    inputs["project"] = compiled["project"]
    inputs["profiles"] = {mid: {"hash": h} for mid, h in compiled["profile_hashes"].items()}
    inputs["supply_compiled"] = {"custom_cf": compiled["custom_cf"], "unsupported": compiled["unsupported"], "reconciliations": compiled["reconciliations"]}
    scenarios.save_inputs(session, actor, scenario.id, expected_revision=expected_revision, inputs=inputs, note=note or "supply configuration")
    return scenarios.get(session, actor, scenario_id), result


def _default_project() -> dict[str, Any]:
    import fdre_enterprise_engine as E

    return E.project_to_dict(E.default_fdre2_project())


def module_template(kind: str, name: str, module_id: str) -> dict[str, Any]:
    """A new module with its default loss chain and every value marked defaulted."""
    losses = [s.model_dump() for s in default_losses(kind)]
    base = {"id": module_id, "kind": kind, "name": name, "node": "POI", "enabled": True, "losses": losses, "provenance": {"kind": "defaulted", "source": "new module"}, "eligibility": {}, "notes": ""}
    if kind == "solar":
        return {**base, "mwp_dc": 130.0, "mwac": 100.0, "degradation_percent_per_year": 0.5, "profile": {"profile_id": None, "basis": "capacity_factor", "capacity_basis": "mwac", "capacity_mw": 100.0, "measured_at": "inverter_ac", "synthetic_cuf_percent": 24.0, "p_level": "P50", "provenance": {"kind": "defaulted", "source": "synthetic profile"}}}
    if kind == "wind":
        return {**base, "installed_mw": 100.0, "turbine_rating_mw": 3.15, "hub_height_m": 140.0, "degradation_percent_per_year": 0.3, "profile": {"profile_id": None, "basis": "capacity_factor", "capacity_basis": "installed_mw", "capacity_mw": 100.0, "measured_at": "generator_terminals", "synthetic_cuf_percent": 32.0, "p_level": "P50", "provenance": {"kind": "defaulted", "source": "synthetic profile"}}}
    if kind in ("thermal", "biomass"):
        return {**base, "kind": kind, "capacity_mw": 50.0, "min_stable_generation_percent": 40.0, "ramp_up_mw_per_min": 1.0, "ramp_down_mw_per_min": 1.0, "min_up_time_h": 4.0, "min_down_time_h": 4.0, "startup_cost_inr": 500000.0, "startup_time_h": 2.0, "shutdown_cost_inr": 0.0, "planned_outage_percent": 5.0, "forced_outage_percent": 3.0, "heat_rate_kcal_per_kwh": 2400.0 if kind == "thermal" else 3300.0, "efficiency_percent": None, "auxiliary_consumption_percent": 8.0 if kind == "thermal" else 10.0, "variable_om_inr_per_mwh": 300.0, "fixed_om_inr_per_mw_year": 1500000.0, "fuel": {"fuel": "coal" if kind == "thermal" else "biomass", "availability_tonnes_per_year": None, "calorific_value_kcal_per_kg": 4000.0 if kind == "thermal" else 3200.0, "price_inr_per_tonne": 3000.0 if kind == "thermal" else 4500.0, "escalation_percent_per_year": 4.0, "provenance": {"kind": "defaulted", "source": "new module"}}, "cost_segments": []}
    if kind == "iex":
        return {**base, "purchase_enabled": True, "sale_enabled": True, "purchase_price_scenarios": [], "sale_price_scenarios": [], "purchase_limit_mw": 0.0, "purchase_limit_mwh_per_day": None, "sale_limit_mw": 0.0, "purchase_charges_inr_per_kwh": 0.0, "sale_charges_inr_per_kwh": 0.0, "delivery_loss_percent": 3.0, "purchase_counts_as_renewable": False, "eligibility_note": ""}
    if kind == "bess":
        return {**base, "power_mw": 50.0, "energy_mwh": 200.0, "soc_min_percent": 10.0, "soc_max_percent": 95.0, "charge_limit_mw": None, "discharge_limit_mw": None, "charge_efficiency_percent": 95.0, "discharge_efficiency_percent": 95.0, "calendar_degradation_percent_per_year": 2.0, "cycle_degradation_percent_per_cycle": 0.005, "augmentation": [], "replacement_year": None, "auxiliary_load_kw": 0.0, "availability_percent": 98.0, "warranty_years": 10, "warranty_cycles": 4000, "throughput_limit_mwh_per_year": None, "cycles_per_day_limit": 1.5, "charging_sources": ["re_colocated"], "renewable_attribution": "re_charged_only"}
    raise ValidationFailed(f"unknown module kind {kind}")


def schema_description() -> dict[str, Any]:
    from fdre_platform.supply.losses import MODEL_INPUTS

    return {"kinds": list(FIELD_META), "fields": FIELD_META, "model_inputs": MODEL_INPUTS, "default_losses": {k: [s.model_dump() for s in default_losses(k)] for k in FIELD_META}}


def supply_config_of(config: SupplyConfig) -> dict[str, Any]:
    return config.model_dump()
