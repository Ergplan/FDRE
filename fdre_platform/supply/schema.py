"""Typed supply modules. Every quantity carries its unit, the electrical boundary it is
measured at and its time basis; every editable value carries provenance. The loss chain is
an ordered list of stages from the generator terminals to the point of interconnection
(POI); stages are applied in order, percentages multiplicatively, and each stage names the
model input it feeds so nothing shown is disconnected from the calculation."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

ModuleKind = Literal["solar", "wind", "thermal", "biomass", "iex", "bess"]
Boundary = Literal["resource", "dc_terminals", "generator_terminals", "inverter_ac", "plant_boundary", "poi"]
BOUNDARY_ORDER: dict[str, int] = {"resource": 0, "dc_terminals": 1, "generator_terminals": 1, "inverter_ac": 2, "plant_boundary": 3, "poi": 4}
TimeBasis = Literal["interval", "hourly", "annual_average"]
LossKind = Literal["percent", "fixed_mw", "availability"]
ProvenanceKind = Literal["user_entered", "defaulted", "vendor", "study", "tender_requirement", "measured"]


class Provenance(BaseModel):
    kind: ProvenanceKind = "defaulted"
    source: str = ""              # document name, vendor, study, requirement field path
    reference: str | None = None  # page, clause, file hash
    entered_by: str | None = None


class LossStage(BaseModel):
    key: str                       # unique within the module: clipping, degradation, availability, ...
    label: str
    kind: LossKind
    value: float                   # percent for percent/availability (0-100), MW for fixed_mw
    unit: Literal["percent", "MW"] = "percent"
    boundary: Boundary             # where the loss is taken
    time_basis: TimeBasis = "hourly"
    included_in_profile: bool = False  # true when the uploaded profile already nets this loss
    model_input: str                   # the engine input this stage feeds
    provenance: Provenance = Field(default_factory=Provenance)
    note: str = ""

    @model_validator(mode="after")
    def _units(self) -> LossStage:
        if self.kind in ("percent", "availability"):
            if self.unit != "percent":
                raise ValueError(f"loss {self.key}: a {self.kind} stage is in percent")
            if not 0 <= self.value <= 100:
                raise ValueError(f"loss {self.key}: percent must be between 0 and 100")
        if self.kind == "fixed_mw":
            if self.unit != "MW":
                raise ValueError(f"loss {self.key}: a fixed load is in MW")
            if self.value < 0:
                raise ValueError(f"loss {self.key}: a fixed load cannot be negative")
        return self


class ProfileRef(BaseModel):
    """Which profile drives the module and what its values mean."""

    profile_id: str | None = None          # a stored, validated profile; None = synthetic from CUF
    basis: Literal["capacity_factor", "mw", "mwh_per_interval"] = "capacity_factor"
    capacity_basis: Literal["mwac", "mwp_dc", "installed_mw", "usable_mwh", "none"] = "mwac"
    capacity_mw: float | None = None       # the capacity the profile's values refer to (for mw/mwh bases and for CUF)
    measured_at: Boundary = "inverter_ac"  # the boundary the profile already represents
    synthetic_cuf_percent: float | None = None  # when no profile is attached
    p_level: Literal["P50", "P75", "P90", "P99"] = "P50"
    provenance: Provenance = Field(default_factory=Provenance)


class ModuleBase(BaseModel):
    id: str
    kind: ModuleKind
    name: str
    node: str = "POI"
    enabled: bool = True
    losses: list[LossStage] = Field(default_factory=list)
    provenance: Provenance = Field(default_factory=Provenance)
    eligibility: dict[str, Any] = Field(default_factory=dict)  # filled from the tender's rules; never a user default
    notes: str = ""

    @field_validator("losses")
    @classmethod
    def _unique_losses(cls, losses: list[LossStage]) -> list[LossStage]:
        seen: set[str] = set()
        for stage in losses:
            if stage.key in seen:
                raise ValueError(f"duplicate loss stage {stage.key!r}")
            seen.add(stage.key)
        order = [BOUNDARY_ORDER[s.boundary] for s in losses]
        if order != sorted(order):
            raise ValueError("loss stages must run from the generator terminals to the POI (boundary order)")
        return losses


class SolarModule(ModuleBase):
    kind: Literal["solar"] = "solar"
    mwp_dc: float = Field(gt=0)
    mwac: float = Field(gt=0)
    profile: ProfileRef = Field(default_factory=ProfileRef)
    degradation_percent_per_year: float = Field(0.5, ge=0, le=5)
    first_year: int = 1

    @property
    def dc_ac_ratio(self) -> float:
        return self.mwp_dc / self.mwac


class WindModule(ModuleBase):
    kind: Literal["wind"] = "wind"
    installed_mw: float = Field(gt=0)
    turbine_rating_mw: float | None = None
    hub_height_m: float | None = None
    profile: ProfileRef = Field(default_factory=ProfileRef)
    degradation_percent_per_year: float = Field(0.3, ge=0, le=5)


class FuelSpec(BaseModel):
    fuel: str = "coal"
    availability_tonnes_per_year: float | None = None
    calorific_value_kcal_per_kg: float = Field(gt=0)
    price_inr_per_tonne: float = Field(ge=0)
    escalation_percent_per_year: float = Field(0, ge=-20, le=50)
    provenance: Provenance = Field(default_factory=Provenance)


class CostSegment(BaseModel):
    """Piecewise variable cost: from `from_mw` upward at `inr_per_mwh`."""

    from_mw: float = Field(ge=0)
    inr_per_mwh: float = Field(ge=0)


class ThermalModule(ModuleBase):
    kind: Literal["thermal", "biomass"] = "thermal"
    capacity_mw: float = Field(gt=0)
    min_stable_generation_percent: float = Field(ge=0, le=100)
    ramp_up_mw_per_min: float = Field(gt=0)
    ramp_down_mw_per_min: float = Field(gt=0)
    min_up_time_h: float = Field(ge=0)
    min_down_time_h: float = Field(ge=0)
    startup_cost_inr: float = Field(ge=0)
    startup_time_h: float = Field(ge=0)
    shutdown_cost_inr: float = Field(0, ge=0)
    planned_outage_percent: float = Field(ge=0, le=100)
    forced_outage_percent: float = Field(ge=0, le=100)
    heat_rate_kcal_per_kwh: float | None = Field(None, gt=0)
    efficiency_percent: float | None = Field(None, gt=0, le=100)
    auxiliary_consumption_percent: float = Field(ge=0, le=30)
    variable_om_inr_per_mwh: float = Field(ge=0)
    fixed_om_inr_per_mw_year: float = Field(ge=0)
    fuel: FuelSpec
    cost_segments: list[CostSegment] = Field(default_factory=list)

    @model_validator(mode="after")
    def _heat(self) -> ThermalModule:
        if (self.heat_rate_kcal_per_kwh is None) == (self.efficiency_percent is None):
            raise ValueError("give exactly one of heat_rate_kcal_per_kwh or efficiency_percent")
        if self.cost_segments and [s.from_mw for s in self.cost_segments] != sorted(s.from_mw for s in self.cost_segments):
            raise ValueError("cost segments must be in increasing MW order")
        return self

    @property
    def heat_rate(self) -> float:
        return self.heat_rate_kcal_per_kwh if self.heat_rate_kcal_per_kwh is not None else 860.0 / (self.efficiency_percent / 100.0)  # type: ignore[operator]


class PriceScenario(BaseModel):
    name: str
    profile_id: str                 # a stored price profile (INR per kWh per interval)
    provenance: Provenance = Field(default_factory=Provenance)


class IexModule(ModuleBase):
    """Exchange purchase and sale as two separate flows. Prices are scenarios; nothing here
    is a guaranteed price or revenue."""

    kind: Literal["iex"] = "iex"
    purchase_enabled: bool = True
    sale_enabled: bool = True
    purchase_price_scenarios: list[PriceScenario] = Field(default_factory=list)
    sale_price_scenarios: list[PriceScenario] = Field(default_factory=list)
    purchase_limit_mw: float = Field(0, ge=0)
    purchase_limit_mwh_per_day: float | None = Field(None, ge=0)
    sale_limit_mw: float = Field(0, ge=0)
    purchase_charges_inr_per_kwh: float = Field(0, ge=0)   # transmission, scheduling, trading margin on purchases
    sale_charges_inr_per_kwh: float = Field(0, ge=0)
    delivery_loss_percent: float = Field(0, ge=0, le=20)
    purchase_counts_as_renewable: bool = False              # green attribution only if the tender allows it
    eligibility_note: str = ""


class AugmentationStep(BaseModel):
    year: int = Field(ge=1)
    energy_mwh: float = Field(ge=0)
    cost_inr_per_kwh: float | None = Field(None, ge=0)
    provenance: Provenance = Field(default_factory=Provenance)


class BessModule(ModuleBase):
    kind: Literal["bess"] = "bess"
    power_mw: float = Field(gt=0)
    energy_mwh: float = Field(gt=0)                  # nameplate
    soc_min_percent: float = Field(ge=0, le=100)
    soc_max_percent: float = Field(ge=0, le=100)
    charge_limit_mw: float | None = Field(None, gt=0)
    discharge_limit_mw: float | None = Field(None, gt=0)
    charge_efficiency_percent: float = Field(gt=0, le=100)
    discharge_efficiency_percent: float = Field(gt=0, le=100)
    calendar_degradation_percent_per_year: float = Field(ge=0, le=20)
    cycle_degradation_percent_per_cycle: float = Field(ge=0, le=1)
    augmentation: list[AugmentationStep] = Field(default_factory=list)
    replacement_year: int | None = None
    auxiliary_load_kw: float = Field(0, ge=0)
    availability_percent: float = Field(ge=0, le=100)
    warranty_years: int | None = None
    warranty_cycles: int | None = None
    throughput_limit_mwh_per_year: float | None = Field(None, gt=0)
    cycles_per_day_limit: float | None = Field(None, gt=0)
    charging_sources: list[Literal["re_colocated", "re_contracted", "grid", "market"]] = Field(default_factory=lambda: ["re_colocated"])
    renewable_attribution: Literal["re_charged_only", "all", "none"] = "re_charged_only"

    @model_validator(mode="after")
    def _soc(self) -> BessModule:
        if self.soc_min_percent >= self.soc_max_percent:
            raise ValueError("soc_min_percent must be below soc_max_percent")
        return self

    @property
    def usable_mwh(self) -> float:
        return self.energy_mwh * (self.soc_max_percent - self.soc_min_percent) / 100.0

    @property
    def round_trip_efficiency(self) -> float:
        return self.charge_efficiency_percent / 100.0 * self.discharge_efficiency_percent / 100.0


Module = SolarModule | WindModule | ThermalModule | IexModule | BessModule


class Node(BaseModel):
    name: str
    interconnection_limit_mw: float = Field(gt=0)
    state: str = ""
    substation: str = ""


class SupplyConfig(BaseModel):
    nodes: list[Node] = Field(default_factory=lambda: [Node(name="POI", interconnection_limit_mw=1000)])
    modules: list[Module] = Field(default_factory=list)
    time_resolution_minutes: Literal[15, 60] = 60

    @model_validator(mode="after")
    def _nodes(self) -> SupplyConfig:
        names = {n.name for n in self.nodes}
        ids: set[str] = set()
        for m in self.modules:
            if m.node not in names:
                raise ValueError(f"module {m.name} references unknown node {m.node}")
            if m.id in ids:
                raise ValueError(f"duplicate module id {m.id}")
            ids.add(m.id)
        return self


def parse_module(data: dict[str, Any]) -> Module:
    kind = data.get("kind")
    cls = {"solar": SolarModule, "wind": WindModule, "thermal": ThermalModule, "biomass": ThermalModule, "iex": IexModule, "bess": BessModule}.get(kind)
    if cls is None:
        raise ValueError(f"unknown module kind {kind!r}")
    return cls.model_validate(data)


def parse_config(data: dict[str, Any]) -> SupplyConfig:
    modules = [parse_module(m) for m in data.get("modules", [])]
    return SupplyConfig(nodes=[Node.model_validate(n) for n in data.get("nodes", [])] or [Node(name="POI", interconnection_limit_mw=1000)], modules=modules, time_resolution_minutes=data.get("time_resolution_minutes", 60))


# Default loss chains per kind: every stage names its model input. These are starting
# points marked `defaulted`; a reviewer replaces them with vendor or study values.
def default_losses(kind: str) -> list[LossStage]:
    P = Provenance(kind="defaulted", source="platform default loss chain")
    if kind == "solar":
        return [
            LossStage(key="dc_losses", label="DC cabling, mismatch and soiling", kind="percent", value=3.0, boundary="dc_terminals", model_input="profile_multiplier", provenance=P),
            LossStage(key="inverter_clipping", label="Inverter clipping (DC/AC ratio)", kind="percent", value=1.5, boundary="inverter_ac", model_input="profile_multiplier", provenance=P),
            LossStage(key="inverter_efficiency", label="Inverter and transformer efficiency", kind="percent", value=2.0, boundary="inverter_ac", model_input="profile_multiplier", provenance=P),
            LossStage(key="auxiliary", label="Plant auxiliary consumption", kind="fixed_mw", value=0.0, unit="MW", boundary="plant_boundary", model_input="profile_aux_mw", provenance=P),
            LossStage(key="availability", label="Plant availability", kind="availability", value=99.0, boundary="plant_boundary", time_basis="annual_average", model_input="generator.availability", provenance=P),
            LossStage(key="evacuation", label="Evacuation line to POI", kind="percent", value=0.5, boundary="poi", model_input="finance.transmission_loss_percent", provenance=P),
        ]
    if kind == "wind":
        return [
            LossStage(key="wake", label="Wake losses", kind="percent", value=6.0, boundary="generator_terminals", model_input="profile_multiplier", provenance=P),
            LossStage(key="electrical", label="Collection and transformer losses", kind="percent", value=2.0, boundary="plant_boundary", model_input="profile_multiplier", provenance=P),
            LossStage(key="curtailment", label="Grid curtailment allowance", kind="percent", value=1.0, boundary="plant_boundary", model_input="profile_multiplier", provenance=P),
            LossStage(key="availability", label="Turbine and BoP availability", kind="availability", value=97.0, boundary="plant_boundary", time_basis="annual_average", model_input="generator.availability", provenance=P),
            LossStage(key="evacuation", label="Evacuation line to POI", kind="percent", value=0.5, boundary="poi", model_input="finance.transmission_loss_percent", provenance=P),
        ]
    if kind in ("thermal", "biomass"):
        return [
            LossStage(key="auxiliary", label="Auxiliary consumption", kind="percent", value=8.0, boundary="plant_boundary", model_input="thermal.auxiliary_consumption_percent", provenance=P),
            LossStage(key="availability", label="Availability after outages", kind="availability", value=90.0, boundary="plant_boundary", time_basis="annual_average", model_input="thermal.availability", provenance=P),
            LossStage(key="evacuation", label="Evacuation line to POI", kind="percent", value=0.5, boundary="poi", model_input="finance.transmission_loss_percent", provenance=P),
        ]
    if kind == "bess":
        return [
            LossStage(key="auxiliary", label="HVAC and controls", kind="fixed_mw", value=0.0, unit="MW", boundary="plant_boundary", model_input="bess.auxiliary_load", provenance=P),
            LossStage(key="availability", label="System availability", kind="availability", value=98.0, boundary="plant_boundary", time_basis="annual_average", model_input="bess.availability", provenance=P),
            LossStage(key="evacuation", label="Evacuation line to POI", kind="percent", value=0.5, boundary="poi", model_input="finance.transmission_loss_percent", provenance=P),
        ]
    if kind == "iex":
        return [LossStage(key="delivery", label="Delivery losses to POI", kind="percent", value=3.0, boundary="poi", model_input="iex.delivery_loss_percent", provenance=P)]
    return []


# What the UI shows per kind: field, label, unit, group and the diagram component the field
# is attached to. Generated from the models so the form and the model cannot drift.
FIELD_META: dict[str, list[dict[str, Any]]] = {
    "solar": [
        {"field": "mwp_dc", "label": "DC capacity", "unit": "MWp", "component": "array"},
        {"field": "mwac", "label": "AC capacity", "unit": "MWac", "component": "inverter"},
        {"field": "degradation_percent_per_year", "label": "Degradation", "unit": "% per year", "component": "array"},
    ],
    "wind": [
        {"field": "installed_mw", "label": "Installed capacity", "unit": "MW", "component": "turbines"},
        {"field": "turbine_rating_mw", "label": "Turbine rating", "unit": "MW", "component": "turbines"},
        {"field": "hub_height_m", "label": "Hub height", "unit": "m", "component": "turbines"},
        {"field": "degradation_percent_per_year", "label": "Degradation", "unit": "% per year", "component": "turbines"},
    ],
    "thermal": [
        {"field": "capacity_mw", "label": "Capacity", "unit": "MW", "component": "unit"},
        {"field": "min_stable_generation_percent", "label": "Minimum stable generation", "unit": "% of capacity", "component": "unit"},
        {"field": "ramp_up_mw_per_min", "label": "Ramp up", "unit": "MW/min", "component": "unit"},
        {"field": "ramp_down_mw_per_min", "label": "Ramp down", "unit": "MW/min", "component": "unit"},
        {"field": "min_up_time_h", "label": "Minimum up time", "unit": "h", "component": "unit"},
        {"field": "min_down_time_h", "label": "Minimum down time", "unit": "h", "component": "unit"},
        {"field": "startup_cost_inr", "label": "Start-up cost", "unit": "INR per start", "component": "unit"},
        {"field": "startup_time_h", "label": "Start-up time", "unit": "h", "component": "unit"},
        {"field": "planned_outage_percent", "label": "Planned outage", "unit": "% of year", "component": "unit"},
        {"field": "forced_outage_percent", "label": "Forced outage", "unit": "% of year", "component": "unit"},
        {"field": "heat_rate_kcal_per_kwh", "label": "Heat rate", "unit": "kcal/kWh", "component": "boiler"},
        {"field": "efficiency_percent", "label": "Efficiency", "unit": "%", "component": "boiler"},
        {"field": "auxiliary_consumption_percent", "label": "Auxiliary consumption", "unit": "% of gross", "component": "aux"},
        {"field": "variable_om_inr_per_mwh", "label": "Variable O&M", "unit": "INR/MWh", "component": "unit"},
        {"field": "fixed_om_inr_per_mw_year", "label": "Fixed O&M", "unit": "INR/MW/year", "component": "unit"},
        {"field": "fuel.fuel", "label": "Fuel", "unit": "", "component": "fuel"},
        {"field": "fuel.availability_tonnes_per_year", "label": "Fuel availability", "unit": "t/year", "component": "fuel"},
        {"field": "fuel.calorific_value_kcal_per_kg", "label": "Calorific value", "unit": "kcal/kg", "component": "fuel"},
        {"field": "fuel.price_inr_per_tonne", "label": "Fuel price", "unit": "INR/t", "component": "fuel"},
        {"field": "fuel.escalation_percent_per_year", "label": "Fuel escalation", "unit": "% per year", "component": "fuel"},
    ],
    "iex": [
        {"field": "purchase_limit_mw", "label": "Purchase limit", "unit": "MW", "component": "purchase"},
        {"field": "purchase_limit_mwh_per_day", "label": "Purchase limit", "unit": "MWh/day", "component": "purchase"},
        {"field": "purchase_charges_inr_per_kwh", "label": "Purchase charges", "unit": "INR/kWh", "component": "purchase"},
        {"field": "sale_limit_mw", "label": "Sale limit", "unit": "MW", "component": "sale"},
        {"field": "sale_charges_inr_per_kwh", "label": "Sale charges", "unit": "INR/kWh", "component": "sale"},
        {"field": "delivery_loss_percent", "label": "Delivery losses", "unit": "%", "component": "delivery"},
        {"field": "purchase_counts_as_renewable", "label": "Purchases count as renewable", "unit": "", "component": "purchase"},
    ],
    "bess": [
        {"field": "power_mw", "label": "Power", "unit": "MW", "component": "pcs"},
        {"field": "energy_mwh", "label": "Nameplate energy", "unit": "MWh", "component": "cells"},
        {"field": "soc_min_percent", "label": "Minimum SOC", "unit": "%", "component": "cells"},
        {"field": "soc_max_percent", "label": "Maximum SOC", "unit": "%", "component": "cells"},
        {"field": "charge_limit_mw", "label": "Charge limit", "unit": "MW", "component": "pcs"},
        {"field": "discharge_limit_mw", "label": "Discharge limit", "unit": "MW", "component": "pcs"},
        {"field": "charge_efficiency_percent", "label": "Charge efficiency", "unit": "%", "component": "pcs"},
        {"field": "discharge_efficiency_percent", "label": "Discharge efficiency", "unit": "%", "component": "pcs"},
        {"field": "calendar_degradation_percent_per_year", "label": "Calendar degradation", "unit": "% per year", "component": "cells"},
        {"field": "cycle_degradation_percent_per_cycle", "label": "Cycle degradation", "unit": "% per cycle", "component": "cells"},
        {"field": "auxiliary_load_kw", "label": "Auxiliary load", "unit": "kW", "component": "aux"},
        {"field": "availability_percent", "label": "Availability", "unit": "%", "component": "pcs"},
        {"field": "warranty_years", "label": "Warranty", "unit": "years", "component": "cells"},
        {"field": "warranty_cycles", "label": "Warranty", "unit": "cycles", "component": "cells"},
        {"field": "throughput_limit_mwh_per_year", "label": "Throughput limit", "unit": "MWh/year", "component": "cells"},
        {"field": "cycles_per_day_limit", "label": "Cycles per day", "unit": "cycles/day", "component": "cells"},
        {"field": "replacement_year", "label": "Replacement year", "unit": "year", "component": "cells"},
    ],
}
FIELD_META["biomass"] = FIELD_META["thermal"]
