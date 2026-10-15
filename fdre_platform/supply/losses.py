"""Loss chains: sequential application of each stage from the generator terminals to the
POI, with a reconciliation table that closes gross energy to net energy, and the checks the
gate demands: every stage maps to a model input, no loss is applied twice (a stage the
profile already includes is shown but not applied), units and boundaries are consistent."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .schema import BOUNDARY_ORDER, LossStage, Module, ProfileRef

HOURS = 8760

# Model inputs a stage may feed. A stage naming anything else is rejected: nothing shown
# may be disconnected from the calculation.
MODEL_INPUTS: dict[str, str] = {
    "profile_multiplier": "multiplies the capacity-factor profile before the engine (legacy GeneratorSpec via custom_cf; MILP: availability-adjusted profile)",
    "profile_aux_mw": "fixed MW subtracted from the profile each hour (clipped at zero)",
    "generator.availability": "GeneratorSpec.availability (legacy) / MILP availability factor",
    "finance.transmission_loss_percent": "FinanceAssumptions.transmission_loss_percent (legacy: a tariff-value deduction on PPA energy; MILP: energy loss at the POI)",
    "thermal.auxiliary_consumption_percent": "ThermalModule.auxiliary_consumption_percent (MILP net output = gross x (1 - aux))",
    "thermal.availability": "MILP derating by planned and forced outages",
    "bess.auxiliary_load": "BESS auxiliary MW drawn every hour (MILP)",
    "bess.availability": "BessSpec.availability (legacy) / MILP",
    "bess.rte": "BessSpec.rte (legacy) / charge and discharge efficiencies (MILP)",
    "iex.delivery_loss_percent": "IexModule.delivery_loss_percent (MILP purchased energy delivered = bought x (1 - loss))",
}


@dataclass
class StageRow:
    key: str
    label: str
    kind: str
    value: float
    unit: str
    boundary: str
    time_basis: str
    applied: bool
    reason: str | None
    energy_in_mwh: float
    loss_mwh: float
    energy_out_mwh: float
    model_input: str
    provenance: str


@dataclass
class Reconciliation:
    module_id: str
    module_name: str
    kind: str
    capacity_basis: str
    capacity_mw: float
    gross_mwh: float
    net_mwh: float
    cuf_gross: float
    cuf_net_on_basis: float
    rows: list[StageRow] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    profile_multiplier: float = 1.0
    aux_mw: float = 0.0
    availability_factor: float = 1.0
    transmission_loss_percent: float = 0.0

    @property
    def closes(self) -> bool:
        total_loss = sum(r.loss_mwh for r in self.rows)
        return abs(self.gross_mwh - total_loss - self.net_mwh) < 1e-6 * max(1.0, self.gross_mwh)

    def as_dict(self) -> dict[str, Any]:
        return {
            "module_id": self.module_id, "module_name": self.module_name, "kind": self.kind, "capacity_basis": self.capacity_basis, "capacity_mw": self.capacity_mw,
            "gross_mwh": round(self.gross_mwh, 3), "net_mwh": round(self.net_mwh, 3), "cuf_gross": round(self.cuf_gross, 5), "cuf_net_on_basis": round(self.cuf_net_on_basis, 5),
            "closes": self.closes, "rows": [r.__dict__ | {"energy_in_mwh": round(r.energy_in_mwh, 3), "loss_mwh": round(r.loss_mwh, 3), "energy_out_mwh": round(r.energy_out_mwh, 3)} for r in self.rows],
            "errors": self.errors, "warnings": self.warnings, "profile_multiplier": round(self.profile_multiplier, 6), "aux_mw": self.aux_mw, "availability_factor": round(self.availability_factor, 6), "transmission_loss_percent": self.transmission_loss_percent,
        }


def validate_stages(stages: list[LossStage], profile: ProfileRef | None) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    keys: set[str] = set()
    for s in stages:
        if s.key in keys:
            errors.append(f"loss {s.key} appears twice")
        keys.add(s.key)
        if s.model_input not in MODEL_INPUTS:
            errors.append(f"loss {s.key} maps to no model input ({s.model_input!r})")
        if profile is not None and profile.profile_id and not s.included_in_profile and BOUNDARY_ORDER[s.boundary] < BOUNDARY_ORDER[profile.measured_at]:
            errors.append(f"loss {s.key} is taken at {s.boundary}, upstream of where the profile is measured ({profile.measured_at}); it is already inside the profile and would be counted twice. Mark it included_in_profile or move the measurement boundary")
        if s.included_in_profile and profile is not None and not profile.profile_id:
            warnings.append(f"loss {s.key} is marked as included in the profile but the module uses a synthetic profile; the loss is not applied")
    availability = [s for s in stages if s.kind == "availability" and not s.included_in_profile]
    if len(availability) > 1:
        errors.append("more than one availability stage: availability is one factor per module")
    return errors, warnings


def apply_chain(hourly_cf: list[float], capacity_mw: float, stages: list[LossStage], *, module_id: str, module_name: str, kind: str, capacity_basis: str, profile: ProfileRef | None = None) -> Reconciliation:
    """Walk the chain hour by hour. Percent stages multiply, fixed MW stages subtract
    (clipped at zero), availability multiplies as an annual-average factor. Returns the
    reconciliation with per-stage energies."""
    errors, warnings = validate_stages(stages, profile)
    gross = [max(0.0, min(1.0, v)) * capacity_mw for v in hourly_cf]
    rec = Reconciliation(module_id=module_id, module_name=module_name, kind=kind, capacity_basis=capacity_basis, capacity_mw=capacity_mw, gross_mwh=sum(gross), net_mwh=0.0, cuf_gross=(sum(gross) / (capacity_mw * len(gross))) if capacity_mw else 0.0, cuf_net_on_basis=0.0, errors=errors, warnings=warnings)
    current = gross
    for s in stages:
        energy_in = sum(current)
        applied = not s.included_in_profile and not errors
        reason = "already inside the uploaded profile; shown, not applied" if s.included_in_profile else None
        if applied:
            if s.kind == "percent":
                f = 1.0 - s.value / 100.0
                nxt = [v * f for v in current]
                if s.model_input == "profile_multiplier":
                    rec.profile_multiplier *= f
                elif s.model_input == "finance.transmission_loss_percent":
                    rec.transmission_loss_percent = 100.0 * (1.0 - (1.0 - rec.transmission_loss_percent / 100.0) * f)
            elif s.kind == "availability":
                f = s.value / 100.0
                nxt = [v * f for v in current]
                rec.availability_factor *= f
            else:  # fixed_mw
                nxt = [max(0.0, v - s.value) for v in current]
                rec.aux_mw += s.value
            current = nxt
        energy_out = sum(current)
        rec.rows.append(StageRow(key=s.key, label=s.label, kind=s.kind, value=s.value, unit=s.unit, boundary=s.boundary, time_basis=s.time_basis, applied=applied, reason=reason, energy_in_mwh=energy_in, loss_mwh=energy_in - energy_out, energy_out_mwh=energy_out, model_input=s.model_input, provenance=s.provenance.kind + (f": {s.provenance.source}" if s.provenance.source else "")))
    rec.net_mwh = sum(current)
    rec.cuf_net_on_basis = (rec.net_mwh / (capacity_mw * len(gross))) if capacity_mw else 0.0
    return rec


def hours_in_year() -> int:
    return HOURS


def module_capacity(module: Module) -> tuple[float, str]:
    """The capacity the module's gross energy is referred to, with its basis label."""
    kind = module.kind
    if kind == "solar":
        return module.mwac, "mwac"  # type: ignore[attr-defined]
    if kind == "wind":
        return module.installed_mw, "installed_mw"  # type: ignore[attr-defined]
    if kind in ("thermal", "biomass"):
        return module.capacity_mw, "installed_mw"  # type: ignore[attr-defined]
    if kind == "bess":
        return module.power_mw, "power_mw"  # type: ignore[attr-defined]
    if kind == "iex":
        return module.purchase_limit_mw, "purchase_limit_mw"  # type: ignore[attr-defined]
    raise ValueError(kind)
