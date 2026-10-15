"""Compile a supply configuration into what the engine consumes: the legacy engine project
(nodes, generators, BESS, tender and finance) plus the custom capacity-factor columns
derived from validated profiles and the applied loss chains. Modules the legacy engine
cannot run (thermal, biomass, IEX) are reported as unsupported with the reason; the Day 4
formulation consumes them directly."""

from __future__ import annotations

from typing import Any

from .losses import Reconciliation, apply_chain, module_capacity
from .profiles import scale_to_cuf, synthetic_hourly
from .schema import ProfileRef, SupplyConfig

HOURS = 8760


class ProfileStore:
    """Resolves profile ids to hourly capacity-factor series (and their metadata)."""

    def __init__(self, lookup) -> None:  # lookup(profile_id) -> dict(hourly, basis, capacity_basis, capacity_mw, sha256, cuf)
        self._lookup = lookup

    def get(self, profile_id: str) -> dict[str, Any]:
        found = self._lookup(profile_id)
        if found is None:
            raise LookupError(f"profile {profile_id} not found")
        return found


def resolve_profile(
    ref: ProfileRef, capacity_mw: float, capacity_basis: str, technology: str, store: ProfileStore | None, seed: int = 42
) -> tuple[list[float], dict[str, Any], list[str]]:
    """The hourly capacity factors on the module's capacity basis, metadata and errors.
    CUF is tied to an explicit capacity and basis: a profile declared on another basis is
    an incompatible unit, not a silent rescale."""
    errors: list[str] = []
    if ref.profile_id and store is not None:
        p = store.get(ref.profile_id)
        hourly = list(p["hourly"])
        p_basis = p.get("capacity_basis") or ref.capacity_basis
        if p_basis != capacity_basis:
            if {p_basis, capacity_basis} == {"mwp_dc", "mwac"} and ref.capacity_mw and capacity_mw:
                # A DC-based solar profile is converted to the AC basis by the DC/AC ratio; clipping is then a real stage.
                factor = ref.capacity_mw / capacity_mw
                hourly = [v * factor for v in hourly]
                meta = {
                    "profile_id": ref.profile_id,
                    "sha256": p.get("sha256"),
                    "basis_converted": f"{p_basis} -> {capacity_basis} by {factor:.4f}",
                    "cuf_on_basis": sum(hourly) / HOURS,
                    "p_level": ref.p_level,
                    "source": "uploaded",
                }
                return hourly, meta, errors
            errors.append(f"profile is on basis {p_basis} but the module's capacity basis is {capacity_basis}: incompatible units")
            return hourly, {"profile_id": ref.profile_id}, errors
        if ref.capacity_mw is not None and abs(ref.capacity_mw - capacity_mw) > 1e-6:
            errors.append(f"profile refers to {ref.capacity_mw} MW but the module's capacity is {capacity_mw} MW on the same basis")
        meta = {"profile_id": ref.profile_id, "sha256": p.get("sha256"), "cuf_on_basis": sum(hourly) / HOURS, "p_level": ref.p_level, "source": "uploaded"}
        return hourly, meta, errors
    if ref.synthetic_cuf_percent is None:
        errors.append("no profile attached and no synthetic CUF given")
        return [0.0] * HOURS, {}, errors
    hourly = synthetic_hourly(technology, ref.synthetic_cuf_percent / 100.0, seed=seed)
    hourly, clipped = scale_to_cuf(hourly, ref.synthetic_cuf_percent / 100.0)
    meta = {"profile_id": None, "sha256": None, "cuf_on_basis": sum(hourly) / HOURS, "source": "synthetic", "clipped_fraction": clipped, "p_level": ref.p_level}
    return hourly, meta, errors


def compile_supply(config: SupplyConfig, base_project: dict[str, Any], store: ProfileStore | None, *, seed: int = 42) -> dict[str, Any]:
    """Returns {project, custom_cf, reconciliations, unsupported, errors, profile_hashes}."""
    project = {
        **base_project,
        "nodes": [{"name": n.name, "interconnection_limit_mw": n.interconnection_limit_mw, "state": n.state, "gss": n.substation} for n in config.nodes],
        "generators": [],
        "bess": [],
    }
    tender = dict(project.get("tender", {}))
    finance = dict(project.get("finance", {}))
    custom_cf: dict[str, list[float]] = {}
    recs: list[Reconciliation] = []
    unsupported: list[dict[str, Any]] = []
    errors: list[str] = []
    profile_hashes: dict[str, str | None] = {}
    tx_losses: list[float] = []
    for m in config.modules:
        if not m.enabled:
            continue
        cap, basis = module_capacity(m)
        if m.kind in ("solar", "wind"):
            tech = m.kind
            hourly, meta, perr = resolve_profile(m.profile, cap, basis, tech, store, seed=seed)  # type: ignore[attr-defined]
            rec = apply_chain(hourly, cap, m.losses, module_id=m.id, module_name=m.name, kind=m.kind, capacity_basis=basis, profile=m.profile)  # type: ignore[attr-defined]
            rec.errors = perr + rec.errors
            recs.append(rec)
            profile_hashes[m.id] = meta.get("sha256")
            if rec.errors:
                errors.extend(f"{m.name}: {e}" for e in rec.errors)
                continue
            # Engine inputs: the profile after multiplicative stages and the fixed aux, availability as a factor,
            # evacuation as the finance transmission loss (legacy engine semantics).
            cf = [max(0.0, v * rec.profile_multiplier - rec.aux_mw / cap) for v in hourly]
            safe = _safe_name(m.name)
            custom_cf[f"gen_{safe}"] = cf
            project["generators"].append(
                {
                    "name": m.name,
                    "technology": tech,
                    "node": m.node,
                    "ac_mw": cap,
                    "dc_mwp": getattr(m, "mwp_dc", 0.0) if tech == "solar" else 0.0,
                    "cuf": meta.get("cuf_on_basis", 0.0),
                    "degradation_per_year": m.degradation_percent_per_year / 100.0,
                    "availability": rec.availability_factor,  # type: ignore[attr-defined]
                    "capex_cr_per_mw": 0.0,
                    "opex_lakh_per_mw_year": 0.0,
                    "merchant_price_factor": 1.0,
                    "notes": f"profile {meta.get('source')} {meta.get('sha256') or ''}".strip(),
                }
            )
            tx_losses.append(rec.transmission_loss_percent)
        elif m.kind == "bess":
            # Round-trip energy: the chain is drawn on the discharge path at the power rating.
            hourly = [1.0] * HOURS
            rec = apply_chain(hourly, cap, m.losses, module_id=m.id, module_name=m.name, kind="bess", capacity_basis=basis)
            recs.append(rec)
            if rec.errors:
                errors.extend(f"{m.name}: {e}" for e in rec.errors)
                continue
            soh = _soh_curve(m.calendar_degradation_percent_per_year, 25)  # type: ignore[attr-defined]
            project["bess"].append(
                {
                    "name": m.name,
                    "node": m.node,
                    "power_mw": m.power_mw,
                    "energy_mwh": m.energy_mwh,
                    "usable_mwh_at_poi": m.usable_mwh,
                    "rte": m.round_trip_efficiency,  # type: ignore[attr-defined]
                    "availability": (m.availability_percent / 100.0) * rec.availability_factor,
                    "charge_power_mw": m.charge_limit_mw,
                    "discharge_power_mw": m.discharge_limit_mw,  # type: ignore[attr-defined]
                    "capex_cr_per_mwh": finance.get("default_bess_capex_cr_per_mwh", 1.10),
                    "pcs_capex_cr_per_mw": finance.get("default_bess_pcs_capex_cr_per_mw", 0.30),
                    "opex_lakh_per_mwh_year": finance.get("default_bess_opex_lakh_per_mwh_year", 1.2),
                    "soh_curve": soh,
                    "rte_curve": [],
                    "augmentation_years": [a.year for a in m.augmentation],
                    "energy_augmentation_schedule": [
                        {"year": a.year, "energy_mwh": a.energy_mwh, "usable_mwh_at_poi": a.energy_mwh * (m.soc_max_percent - m.soc_min_percent) / 100.0}
                        for a in m.augmentation
                    ],  # type: ignore[attr-defined]
                    "notes": f"charging sources {','.join(m.charging_sources)}; attribution {m.renewable_attribution}; aux {m.auxiliary_load_kw} kW",  # type: ignore[attr-defined]
                }
            )
            tx_losses.append(rec.transmission_loss_percent)
        else:
            cap_label = f"{cap} MW"
            stages = list(m.losses)
            if m.kind in ("thermal", "biomass"):
                # The auxiliary stage mirrors the module's own field: one number, shown in two places.
                stages = [
                    st.model_copy(update={"value": m.auxiliary_consumption_percent})
                    if st.key == "auxiliary" and st.model_input == "thermal.auxiliary_consumption_percent"
                    else st
                    for st in stages
                ]  # type: ignore[attr-defined]
            rec = apply_chain([1.0] * HOURS, cap, stages, module_id=m.id, module_name=m.name, kind=m.kind, capacity_basis=basis) if cap > 0 else None
            if rec is not None:
                recs.append(rec)
                if rec.errors:
                    errors.extend(f"{m.name}: {e}" for e in rec.errors)
            unsupported.append(
                {
                    "module_id": m.id,
                    "name": m.name,
                    "kind": m.kind,
                    "capacity": cap_label,
                    "reason": "the legacy dispatch engine models solar, wind and RE-charged BESS only; this module is kept, validated and reconciled, and runs through the Day 4 MILP formulation",
                }
            )
    if tx_losses:
        finance["transmission_loss_percent"] = max(tx_losses)  # the legacy engine has one value; the strictest line applies
    project["tender"] = tender
    project["finance"] = finance
    return {
        "project": project,
        "custom_cf": custom_cf,
        "reconciliations": [r.as_dict() for r in recs],
        "unsupported": unsupported,
        "errors": errors,
        "profile_hashes": profile_hashes,
    }


def _safe_name(name: str) -> str:
    """Same rule as fdre_enterprise_engine._safe_name, so the compiled column is the one the
    engine looks up for the generator (lowercase, non-alphanumerics to underscores)."""
    return "".join(ch if ch.isalnum() else "_" for ch in name.strip().lower()).strip("_")


def _soh_curve(calendar_pct_per_year: float, years: int) -> list[float]:
    f = 1.0 - calendar_pct_per_year / 100.0
    return [round(f**y, 5) for y in range(years)]
