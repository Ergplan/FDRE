"""
Enterprise FDRE optimization engine for NHPC/SECI-style firm-and-dispatchable
renewable energy tenders.

The module is intentionally self-contained: it uses dataclasses, numpy, pandas
and scipy only.  It supports:
  * multi-node solar/wind/BESS configurations with interconnection limits;
  * hourly 8760 dispatch with morning/evening buyer peak windows;
  * monthly 90% peak-availability tests and annual CUF tests;
  * RE-only BESS charging, optional external green-power support capped by rule;
  * 25-year tariff, debt, tax, working-capital and DSCR model;
  * hard-constrained tariff solving and HiGHS-seeded capacity sizing.

Money is stored in Indian Rupees crore unless stated otherwise. Energy is MWh.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple
import copy
import json
import math
import pathlib

import numpy as np
import pandas as pd
from scipy.optimize import linprog

HOURS_PER_DAY = 24
DAYS_PER_YEAR = 365
HOURS_PER_YEAR = HOURS_PER_DAY * DAYS_PER_YEAR
MONTH_DAYS = np.array([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], dtype=int)
MONTH_LABELS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
MONTH_START_DAY = np.concatenate([[0], np.cumsum(MONTH_DAYS)[:-1]])
MONTH_OF_DAY = np.repeat(np.arange(12), MONTH_DAYS)
MONTH_OF_HOUR = np.repeat(MONTH_OF_DAY, HOURS_PER_DAY)
DAY_OF_HOUR = np.repeat(np.arange(DAYS_PER_YEAR), HOURS_PER_DAY)
HOUR_OF_DAY = np.tile(np.arange(HOURS_PER_DAY), DAYS_PER_YEAR)

SOLAR_MONTHLY_SHAPE = np.array([0.96, 1.04, 1.12, 1.15, 1.13, 0.92, 0.78, 0.80, 0.92, 1.04, 1.02, 0.96])
WIND_MONTHLY_SHAPE = np.array([0.72, 0.74, 0.84, 0.94, 1.18, 1.58, 1.72, 1.58, 1.18, 0.90, 0.76, 0.70])
DAY_LENGTH = np.array([10.8, 11.3, 12.0, 12.7, 13.3, 13.6, 13.4, 12.9, 12.2, 11.5, 10.9, 10.6])


def _safe_name(name: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in name.strip().lower()).strip("_")


def _stable_seed_offset(text: str) -> int:
    return sum((i + 1) * ord(ch) for i, ch in enumerate(text)) % 100_000


def _as_float(value: Any, default: float = 0.0) -> float:
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


@dataclass
class NodeSpec:
    name: str
    interconnection_limit_mw: float
    state: str = ""
    gss: str = ""


@dataclass
class GeneratorSpec:
    name: str
    technology: str  # "solar" or "wind"
    node: str
    ac_mw: float
    dc_mwp: float = 0.0
    cuf: float = 0.28
    degradation_per_year: float = 0.005
    availability: float = 1.0
    capex_cr_per_mw: float = 0.0
    opex_lakh_per_mw_year: float = 0.0
    merchant_price_factor: float = 1.0
    notes: str = ""

    def clone_scaled(self, scale: float) -> "GeneratorSpec":
        return replace(self, ac_mw=self.ac_mw * scale, dc_mwp=self.dc_mwp * scale)


@dataclass
class BessSpec:
    name: str
    node: str
    power_mw: float
    energy_mwh: float
    usable_mwh_at_poi: float
    rte: float = 0.8668
    availability: float = 1.0
    charge_power_mw: Optional[float] = None
    discharge_power_mw: Optional[float] = None
    capex_cr_per_mwh: float = 1.10
    pcs_capex_cr_per_mw: float = 0.30
    opex_lakh_per_mwh_year: float = 1.20
    soh_curve: List[float] = field(default_factory=list)  # fractions, year 1 = 1.0
    rte_curve: List[float] = field(default_factory=list)  # fractions, e.g. 0.8668
    augmentation_years: List[int] = field(default_factory=list)
    energy_augmentation_schedule: List[Dict[str, float]] = field(default_factory=list)
    notes: str = ""

    def usable_for_year(self, year: int) -> float:
        idx = max(0, int(year) - 1)
        if self.soh_curve:
            soh = self.soh_curve[idx] if idx < len(self.soh_curve) else self.soh_curve[-1]
        else:
            soh = 1.0
        usable = self.usable_mwh_at_poi * soh
        for item in self.energy_augmentation_schedule:
            install_year = int(item.get("year", 0))
            if install_year <= 0 or int(year) < install_year:
                continue
            add_usable = float(item.get("usable_mwh_at_poi", 0.0))
            age_idx = max(0, int(year) - install_year)
            if self.soh_curve:
                add_soh = self.soh_curve[age_idx] if age_idx < len(self.soh_curve) else self.soh_curve[-1]
            else:
                add_soh = 1.0
            usable += add_usable * add_soh
        return max(0.0, usable * self.availability)

    def rte_for_year(self, year: int) -> float:
        idx = max(0, int(year) - 1)
        if self.rte_curve:
            rte = self.rte_curve[idx] if idx < len(self.rte_curve) else self.rte_curve[-1]
        else:
            rte = self.rte
        return min(max(float(rte), 0.50), 1.0)

    def charge_limit(self) -> float:
        return self.power_mw if self.charge_power_mw is None else self.charge_power_mw

    def discharge_limit(self) -> float:
        return self.power_mw if self.discharge_power_mw is None else self.discharge_power_mw

    def clone_scaled(self, power_scale: float, energy_scale: float) -> "BessSpec":
        return replace(
            self,
            power_mw=self.power_mw * power_scale,
            charge_power_mw=None if self.charge_power_mw is None else self.charge_power_mw * power_scale,
            discharge_power_mw=None if self.discharge_power_mw is None else self.discharge_power_mw * power_scale,
            energy_mwh=self.energy_mwh * energy_scale,
            usable_mwh_at_poi=self.usable_mwh_at_poi * energy_scale,
            energy_augmentation_schedule=[
                {
                    **item,
                    "energy_mwh": float(item.get("energy_mwh", 0.0)) * energy_scale,
                    "usable_mwh_at_poi": float(item.get("usable_mwh_at_poi", 0.0)) * energy_scale,
                }
                for item in self.energy_augmentation_schedule
            ],
        )


@dataclass
class TenderRules:
    tender_name: str = "NHPC FDRE Tranche-II"
    contracted_capacity_mw: float = 200.0
    declared_annual_cuf: float = 0.40
    ppa_years: int = 25
    min_project_mw: float = 50.0
    project_mw_multiple: float = 10.0
    max_bidder_capacity_mw: float = 600.0
    peak_availability_floor: float = 0.90
    cuf_lower_tolerance: float = 0.15
    cuf_upper_multiplier: float = 1.10
    penalty_multiplier: float = 1.50
    psm_charge_rs_per_kwh: float = 0.02
    trading_margin_rs_per_kwh: float = 0.07
    success_charge_lakh_per_mw: float = 1.0
    success_charge_gst: float = 0.18
    external_green_limit_fraction: float = 0.05
    allow_external_green_purchase: bool = False
    external_green_price_rs_per_kwh: float = 4.50
    ppa_non_peak_take_fraction: float = 1.0
    reserve_ppa_cap_for_future_peak: bool = True
    peak_schedule_mode: str = "fixed"  # fixed or worst_deficit_daily
    morning_window: Tuple[int, int] = (5, 10)  # inclusive start, exclusive end
    evening_window: Tuple[int, int] = (18, 23)
    fixed_morning_peak_hours: Tuple[int, int] = (7, 8)
    fixed_evening_peak_hours: Tuple[int, int] = (19, 20)
    # The RfS liquidated-damages illustration uses 8766 hours for annual CUF.
    cuf_hours_per_year: int = 8766
    first_contract_year_relief: bool = False
    hard_monthly_peak_compliance: bool = True
    hard_annual_cuf_compliance: bool = True

    @property
    def annual_cuf_floor(self) -> float:
        return self.declared_annual_cuf * (1.0 - self.cuf_lower_tolerance)

    @property
    def annual_cuf_ceiling(self) -> float:
        return self.declared_annual_cuf * self.cuf_upper_multiplier

    @property
    def annual_ppa_cap_mwh(self) -> float:
        return self.annual_cuf_ceiling * self.contracted_capacity_mw * self.cuf_hours_per_year

    @property
    def annual_min_mwh(self) -> float:
        return self.annual_cuf_floor * self.contracted_capacity_mw * self.cuf_hours_per_year


@dataclass
class FinanceAssumptions:
    target_equity_irr: float = 0.14
    min_dscr: float = 1.10
    debt_fraction: float = 0.75
    interest_rate: float = 0.0875
    debt_tenor_years: int = 18
    repayment_style: str = "sculpted"  # sculpted or annuity
    sculpt_target_dscr: float = 1.10
    size_debt_by_dscr: bool = True
    construction_months: int = 24
    construction_drawdown: Tuple[float, float] = (0.45, 0.55)
    discount_rate: float = 0.10
    tax_rate: float = 0.25168
    tax_wdv_rate: float = 0.40
    tax_depreciable_basis_fraction: float = 0.95
    book_depreciation_years: int = 25
    residual_value_fraction: float = 0.05
    receivable_days: float = 60.0
    working_capital_interest_rate: float = 0.095
    opex_escalation: float = 0.035
    insurance_percent_hard_capex: float = 0.0035
    admin_opex_cr_year: float = 5.0
    admin_opex_lakh_per_mw_year: float = 0.75
    land_and_development_cr: float = 0.0
    land_solar_cr_per_mw_ac: float = 0.45
    land_wind_cr_per_mw: float = 0.08
    land_bess_cr_per_mwh: float = 0.02
    transmission_lump_sum_cr: float = 0.0
    transmission_cr_per_mw: float = 1.00
    transmission_opex_lakh_per_mw_year: float = 2.00
    transmission_loss_percent: float = 0.50
    owner_costs_cr: float = 0.0
    owner_costs_cr_per_mw: float = 0.12
    contingency_percent: float = 0.03
    default_solar_capex_cr_per_mw_ac: float = 3.10
    default_wind_capex_cr_per_mw: float = 6.50
    default_bess_capex_cr_per_mwh: float = 1.10
    default_bess_pcs_capex_cr_per_mw: float = 0.30
    default_solar_opex_lakh_per_mw_year: float = 5.5
    default_wind_opex_lakh_per_mw_year: float = 11.0
    default_bess_opex_lakh_per_mwh_year: float = 1.2
    bess_augmentation_schedule: List[Dict[str, float]] = field(default_factory=lambda: [
        {"year": 11, "energy_replacement_fraction": 1.0, "cost_cr_per_mwh": 0.75}
    ])
    terminal_value_cr: float = 0.0
    hard_compliance_required: bool = True


@dataclass
class SimulationAssumptions:
    seed: int = 42
    solar_variability: float = 0.10
    wind_variability: float = 0.25
    merchant_price_rs_per_kwh: float = 3.25
    merchant_escalation: float = 0.02
    merchant_curtailment_haircut: float = 0.08
    circular_soc_iterations: int = 3
    initial_soc_fraction: float = 0.50
    nonpeak_discharge_soc_reserve_fraction: float = 0.98
    use_custom_profiles: bool = False


@dataclass
class ProjectConfig:
    name: str
    nodes: List[NodeSpec]
    generators: List[GeneratorSpec]
    bess: List[BessSpec]
    tender: TenderRules = field(default_factory=TenderRules)
    finance: FinanceAssumptions = field(default_factory=FinanceAssumptions)
    simulation: SimulationAssumptions = field(default_factory=SimulationAssumptions)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def node_map(self) -> Dict[str, NodeSpec]:
        return {n.name: n for n in self.nodes}

    def validate(self) -> List[str]:
        warnings: List[str] = []
        nodes = self.node_map()
        for gen in self.generators:
            if gen.node not in nodes:
                warnings.append(f"Generator {gen.name} references missing node {gen.node}.")
            if gen.technology.lower() not in {"solar", "wind"}:
                warnings.append(f"Generator {gen.name} has unsupported technology {gen.technology}.")
            if gen.ac_mw < 0:
                warnings.append(f"Generator {gen.name} has negative AC MW.")
        for b in self.bess:
            if b.node not in nodes:
                warnings.append(f"BESS {b.name} references missing node {b.node}.")
            if b.power_mw < 0 or b.usable_mwh_at_poi < 0:
                warnings.append(f"BESS {b.name} has negative power or energy.")
        cc = self.tender.contracted_capacity_mw
        if cc < self.tender.min_project_mw:
            warnings.append(f"Contracted capacity {cc:.1f} MW is below minimum {self.tender.min_project_mw:.1f} MW.")
        if cc > self.tender.max_bidder_capacity_mw:
            warnings.append(f"Contracted capacity {cc:.1f} MW exceeds bidder cap {self.tender.max_bidder_capacity_mw:.1f} MW.")
        multiple = self.tender.project_mw_multiple
        if multiple and abs((cc / multiple) - round(cc / multiple)) > 1e-6:
            warnings.append(f"Contracted capacity {cc:.1f} MW is not a multiple of {multiple:.1f} MW.")
        if self.tender.declared_annual_cuf < 0.40:
            warnings.append("Declared annual CUF is below the RfS minimum of 40%.")
        if sum(b.power_mw for b in self.bess) + 1e-9 < self.tender.peak_availability_floor * cc:
            warnings.append("BESS power alone is below the 90% peak availability floor; wind/solar during peak must cover the balance.")
        fin_aug_years = sorted({int(item.get("year", 0)) for item in self.finance.bess_augmentation_schedule
                                if int(item.get("year", 0)) > 0})
        for b in self.bess:
            spec_years = sorted(int(y) for y in b.augmentation_years)
            if b.soh_curve and spec_years != fin_aug_years:
                warnings.append(
                    f"BESS {b.name}: augmentation years in the BESS spec {spec_years} differ from the finance "
                    f"augmentation schedule {fin_aug_years}. Physical capacity recovery is driven by the SOH curve "
                    f"(and its reset year), while augmentation capex is driven by the finance schedule - if they "
                    f"disagree, dispatch and cash flows will silently diverge.")
        return warnings


@dataclass
class DispatchResult:
    summary: Dict[str, float]
    monthly: pd.DataFrame
    hourly: Optional[pd.DataFrame] = None


@dataclass
class CapexResult:
    components: Dict[str, float]
    hard_capex_cr: float
    idc_cr: float
    total_project_cost_cr: float
    debt_cr: float
    equity_cr: float
    emd_cr: float
    pbg_cr: float


@dataclass
class FinanceResult:
    tariff_rs_per_kwh: float
    equity_irr: float
    project_irr: float
    min_dscr: float
    avg_dscr: float
    npv_equity_cr: float
    capex: CapexResult
    table: pd.DataFrame
    equity_cashflows: np.ndarray
    project_cashflows: np.ndarray


# ---------------------------------------------------------------------------
# Serialization


def project_to_dict(project: ProjectConfig) -> Dict[str, Any]:
    return asdict(project)


def project_from_dict(data: Mapping[str, Any]) -> ProjectConfig:
    if "nodes" not in data or "generators" not in data or "bess" not in data:
        raise ValueError(
            "Project JSON must use the engine schema with 'nodes', 'generators', and 'bess'. "
            "Use the app's exported current_fdre_project_config.json or the bundled project_config_fdre2.json."
        )
    tender = TenderRules(**data.get("tender", {}))
    finance = FinanceAssumptions(**data.get("finance", {}))
    simulation = SimulationAssumptions(**data.get("simulation", {}))
    nodes = [NodeSpec(**n) for n in data.get("nodes", [])]
    generators = [GeneratorSpec(**g) for g in data.get("generators", [])]
    bess = [BessSpec(**b) for b in data.get("bess", [])]
    return ProjectConfig(
        name=data.get("name", "FDRE Project"),
        nodes=nodes,
        generators=generators,
        bess=bess,
        tender=tender,
        finance=finance,
        simulation=simulation,
        metadata=dict(data.get("metadata", {})),
    )


def save_project_config(project: ProjectConfig, path: str | pathlib.Path) -> None:
    pathlib.Path(path).write_text(json.dumps(project_to_dict(project), indent=2), encoding="utf-8")


def load_project_config(path: str | pathlib.Path) -> ProjectConfig:
    return project_from_dict(json.loads(pathlib.Path(path).read_text(encoding="utf-8")))


# ---------------------------------------------------------------------------
# Default configuration extracted from the uploaded project configuration.


def _fdre2_bess_soh_curve() -> List[float]:
    # Uploaded table is stated on 217.94 MWh DC usable; convert to fractions.
    vals = [217.94, 208.46, 203.60, 199.44, 195.71, 192.24, 189.02, 185.97, 183.07, 180.28,
            217.94, 208.46, 203.60, 199.44, 195.71, 192.24, 189.02, 185.97, 183.07, 180.28]
    base = vals[0]
    return [v / base for v in vals]


def _fdre2_bess_rte_curve() -> List[float]:
    return [0.8668, 0.8668, 0.8612, 0.8612, 0.8612, 0.8612, 0.8557, 0.8557, 0.8557, 0.8557,
            0.8668, 0.8668, 0.8612, 0.8612, 0.8612, 0.8612, 0.8557, 0.8557, 0.8557, 0.8557]


def default_fdre2_project() -> ProjectConfig:
    soh = _fdre2_bess_soh_curve()
    rte = _fdre2_bess_rte_curve()
    nodes = [
        NodeSpec("Fatehgarh_4S2", 30.0, state="Rajasthan", gss="Fatehgarh 4S2"),
        NodeSpec("Bikaner_III", 150.0, state="Rajasthan", gss="Bikaner III"),
        NodeSpec("Bikaner_II", 100.0, state="Rajasthan", gss="Bikaner II"),
    ]
    generators = [
        GeneratorSpec(
            name="Barmer_Wind_S144",
            technology="wind",
            node="Fatehgarh_4S2",
            ac_mw=31.5,
            dc_mwp=0.0,
            cuf=0.34,
            degradation_per_year=0.002,
            capex_cr_per_mw=6.5,
            opex_lakh_per_mw_year=11.0,
            notes="10 x S144 3.15 MW WTGs; total loss with wake 24.35% in uploaded configuration.",
        ),
        GeneratorSpec(
            name="Bikaner_III_Solar",
            technology="solar",
            node="Bikaner_III",
            ac_mw=240.0,
            dc_mwp=360.0,
            cuf=0.275,
            degradation_per_year=0.005,
            capex_cr_per_mw=3.10,
            opex_lakh_per_mw_year=5.5,
            merchant_price_factor=0.85,
            notes="TOPCon bifacial, 1.5 DC/AC, 360 MWp / 240 MWac.",
        ),
        GeneratorSpec(
            name="Bikaner_II_Solar",
            technology="solar",
            node="Bikaner_II",
            ac_mw=60.0,
            dc_mwp=90.0,
            cuf=0.275,
            degradation_per_year=0.005,
            capex_cr_per_mw=3.10,
            opex_lakh_per_mw_year=5.5,
            merchant_price_factor=0.85,
            notes="TOPCon bifacial, 1.5 DC/AC, 90 MWp / 60 MWac.",
        ),
    ]
    bess = [
        BessSpec(
            name="Bikaner_III_BESS",
            node="Bikaner_III",
            power_mw=135.0,
            energy_mwh=540.0,
            usable_mwh_at_poi=500.0,
            rte=0.8668,
            soh_curve=soh,
            rte_curve=rte,
            augmentation_years=[11],
            capex_cr_per_mwh=1.10,
            pcs_capex_cr_per_mw=0.30,
            notes="Project table: 540 MWh / 135 MW C/4; BESS spec states 600 MWh nameplate, 560 MWh DC usable, 500 MWh at PoI.",
        ),
        BessSpec(
            name="Bikaner_II_BESS",
            node="Bikaner_II",
            power_mw=50.0,
            energy_mwh=200.0,
            usable_mwh_at_poi=200.0,
            rte=0.8668,
            soh_curve=soh,
            rte_curve=rte,
            augmentation_years=[11],
            capex_cr_per_mwh=1.10,
            pcs_capex_cr_per_mw=0.30,
            notes="Project table: 200 MWh / 50 MW C/4; BESS spec states 234.82 MWh nameplate, 217.94 MWh DC usable, 200 MWh at PoI.",
        ),
    ]
    tender = TenderRules(
        contracted_capacity_mw=200.0,
        declared_annual_cuf=0.40,
        peak_schedule_mode="fixed",
        fixed_morning_peak_hours=(7, 8),
        fixed_evening_peak_hours=(19, 20),
        ppa_non_peak_take_fraction=1.0,
    )
    finance = FinanceAssumptions()
    simulation = SimulationAssumptions(seed=42)
    metadata = {
        "source_files": ["PROJECT CONFIGURATION_FDRE 2.docx", "RFS.pdf"],
        "model_scope": "Hourly bid-screening and sizing optimizer; replace synthetic profiles with measured P50/P90/Pxx traces before investment approval.",
    }
    return ProjectConfig("FDRE_2_Rajasthan_Portfolio", nodes, generators, bess, tender, finance, simulation, metadata)


# ---------------------------------------------------------------------------
# Resource profiles


def _scale_to_mean(arr: np.ndarray, target: float, cap: float = 1.0) -> np.ndarray:
    out = np.array(arr, dtype=float)
    if target <= 0:
        return np.zeros_like(out)
    for _ in range(7):
        mean = out.mean()
        if mean <= 1e-12:
            break
        out *= target / mean
        out = np.clip(out, 0.0, cap)
    return out


def synthetic_capacity_factor(technology: str, cuf: float, seed: int = 42,
                              solar_variability: float = 0.10,
                              wind_variability: float = 0.25) -> np.ndarray:
    """Return an 8760 capacity-factor trace with the requested annual CUF."""
    rng = np.random.default_rng(int(seed))
    h = HOUR_OF_DAY
    if technology.lower() == "solar":
        profile = np.zeros(HOURS_PER_YEAR, dtype=float)
        for m in range(12):
            dl = DAY_LENGTH[m]
            sunrise = 12.0 - dl / 2.0
            sunset = 12.0 + dl / 2.0
            hour_shape = np.where(
                (np.arange(24) > sunrise) & (np.arange(24) < sunset),
                np.cos((np.arange(24) - 12.0) / (dl / 2.0) * np.pi / 2.0).clip(0.0) ** 1.35,
                0.0,
            )
            day_idx = np.where(MONTH_OF_DAY == m)[0]
            month_days = len(day_idx)
            day_noise = rng.normal(1.0, solar_variability, month_days).clip(0.45, 1.25)
            # Lower monsoon months add more low-output days.
            if m in (5, 6, 7, 8):
                day_noise *= rng.normal(0.92, solar_variability * 0.8, month_days).clip(0.55, 1.15)
            for j, d in enumerate(day_idx):
                profile[d * 24:(d + 1) * 24] = hour_shape * SOLAR_MONTHLY_SHAPE[m] * day_noise[j]
        return _scale_to_mean(profile, cuf, cap=1.0)

    if technology.lower() == "wind":
        diurnal = 1.0 + 0.12 * np.sin((np.arange(24) - 8) / 24.0 * 2.0 * np.pi)
        base = WIND_MONTHLY_SHAPE[MONTH_OF_HOUR] * diurnal[h]
        ar = np.zeros(HOURS_PER_YEAR, dtype=float)
        eps = rng.normal(0.0, wind_variability, HOURS_PER_YEAR)
        for i in range(1, HOURS_PER_YEAR):
            ar[i] = 0.92 * ar[i - 1] + eps[i]
        profile = base * np.exp(ar - 0.5 * np.var(ar))
        return _scale_to_mean(profile, cuf, cap=1.0)

    raise ValueError(f"Unsupported technology: {technology!r}")


def generation_profile(project: ProjectConfig, year: int = 1,
                       custom_cf: Optional[pd.DataFrame] = None) -> pd.DataFrame:
    """Build hourly generation by asset and node for the specified operating year."""
    sim = project.simulation
    data: Dict[str, Any] = {
        "month": MONTH_OF_HOUR + 1,
        "day": DAY_OF_HOUR + 1,
        "hour": HOUR_OF_DAY,
    }
    for gen in project.generators:
        col = f"gen_{_safe_name(gen.name)}"
        if custom_cf is not None and col in custom_cf.columns:
            cf = np.asarray(custom_cf[col], dtype=float)[:HOURS_PER_YEAR]
        elif custom_cf is not None and f"{_safe_name(gen.name)}_cf" in custom_cf.columns:
            cf = np.asarray(custom_cf[f"{_safe_name(gen.name)}_cf"], dtype=float)[:HOURS_PER_YEAR]
        elif custom_cf is not None and f"{gen.technology.lower()}_cf" in custom_cf.columns:
            cf = np.asarray(custom_cf[f"{gen.technology.lower()}_cf"], dtype=float)[:HOURS_PER_YEAR]
        else:
            seed = sim.seed + _stable_seed_offset(gen.name)
            cf = synthetic_capacity_factor(
                gen.technology,
                gen.cuf,
                seed=seed,
                solar_variability=sim.solar_variability,
                wind_variability=sim.wind_variability,
            )
        if len(cf) < HOURS_PER_YEAR:
            raise ValueError(f"Profile for {gen.name} must have at least 8760 rows.")
        degradation = (1.0 - gen.degradation_per_year) ** max(0, year - 1)
        data[col] = np.clip(cf[:HOURS_PER_YEAR], 0.0, 1.0) * gen.ac_mw * gen.availability * degradation
    df = pd.DataFrame(data)
    for node in project.nodes:
        node_cols = [f"gen_{_safe_name(g.name)}" for g in project.generators if g.node == node.name]
        df[f"node_gen_{_safe_name(node.name)}"] = df[node_cols].sum(axis=1) if node_cols else 0.0
    df["total_re_mw"] = df[[f"gen_{_safe_name(g.name)}" for g in project.generators]].sum(axis=1) if project.generators else 0.0
    return df


# ---------------------------------------------------------------------------
# Dispatch


def build_peak_target(project: ProjectConfig, profile: pd.DataFrame) -> np.ndarray:
    rules = project.tender
    target = np.zeros(HOURS_PER_YEAR, dtype=float)
    cc = rules.contracted_capacity_mw
    if rules.peak_schedule_mode == "fixed":
        hours = set(rules.fixed_morning_peak_hours) | set(rules.fixed_evening_peak_hours)
        target[np.isin(HOUR_OF_DAY, list(hours))] = cc
        return target

    if rules.peak_schedule_mode == "worst_deficit_daily":
        morning_hours = np.arange(rules.morning_window[0], rules.morning_window[1])
        evening_hours = np.arange(rules.evening_window[0], rules.evening_window[1])
        gen = np.asarray(profile["total_re_mw"], dtype=float)
        for d in range(DAYS_PER_YEAR):
            start = d * 24
            m_idx = start + morning_hours
            e_idx = start + evening_hours
            # Select the two hours with the largest pre-storage shortfall.
            m_pick = m_idx[np.argsort(cc - gen[m_idx])[-2:]]
            e_pick = e_idx[np.argsort(cc - gen[e_idx])[-2:]]
            target[m_pick] = cc
            target[e_pick] = cc
        return target

    raise ValueError(f"Unsupported peak_schedule_mode: {rules.peak_schedule_mode!r}")


def _bess_arrays(project: ProjectConfig, year: int) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, List[str]]:
    node_index = {node.name: i for i, node in enumerate(project.nodes)}
    nodes = []
    charge_p = []
    discharge_p = []
    max_soc = []
    rte = []
    names = []
    for b in project.bess:
        nodes.append(node_index[b.node])
        charge_p.append(b.charge_limit())
        discharge_p.append(b.discharge_limit())
        max_soc.append(b.usable_for_year(year))
        rte.append(b.rte_for_year(year))
        names.append(b.name)
    return (np.asarray(nodes, dtype=int), np.asarray(charge_p, dtype=float),
            np.asarray(discharge_p, dtype=float), np.asarray(max_soc, dtype=float),
            np.asarray(rte, dtype=float), names)


def _simulate_dispatch_pass(project: ProjectConfig, profile: pd.DataFrame, peak_target: np.ndarray,
                            year: int, initial_soc: np.ndarray) -> Tuple[Dict[str, np.ndarray], np.ndarray]:
    rules = project.tender
    sim = project.simulation
    node_names = [n.name for n in project.nodes]
    node_limits = np.asarray([n.interconnection_limit_mw for n in project.nodes], dtype=float)
    node_gen_cols = [f"node_gen_{_safe_name(n)}" for n in node_names]
    node_gen = profile[node_gen_cols].to_numpy(dtype=float)

    b_nodes, b_charge_p, b_discharge_p, b_max_soc, b_rte, _ = _bess_arrays(project, year)
    n_bess = len(b_nodes)
    soc = np.minimum(np.maximum(initial_soc.copy(), 0.0), b_max_soc)

    peak_remaining = np.cumsum(peak_target[::-1])[::-1] - peak_target
    direct_peak_available = np.minimum(node_gen, node_limits).sum(axis=1)
    peak_deficit_need = np.maximum(0.0, peak_target - direct_peak_available)
    next_peak_reserve = np.zeros(HOURS_PER_YEAR, dtype=float)
    peak_hours = np.flatnonzero(peak_target > 0.0)
    if len(peak_hours):
        blocks: List[Tuple[int, int]] = []
        start = int(peak_hours[0])
        prev = int(peak_hours[0])
        for hour in peak_hours[1:]:
            hour = int(hour)
            if hour == prev + 1:
                prev = hour
                continue
            blocks.append((start, prev))
            start = prev = hour
        blocks.append((start, prev))
        for i, (start, end) in enumerate(blocks):
            reserve = float(peak_deficit_need[start:end + 1].sum())
            prev_end = blocks[i - 1][1] if i > 0 else blocks[-1][1] - HOURS_PER_YEAR
            reserve_start = max(0, prev_end + 1)
            next_peak_reserve[reserve_start:start] = reserve
            if i == 0 and blocks[-1][1] + 1 < HOURS_PER_YEAR:
                next_peak_reserve[blocks[-1][1] + 1:] = reserve

    ppa_cap_mwh = rules.annual_ppa_cap_mwh

    out = {k: np.zeros(HOURS_PER_YEAR, dtype=float) for k in [
        "ppa_peak_mwh", "ppa_nonpeak_mwh", "merchant_mwh", "spill_mwh", "bess_charge_mwh",
        "bess_discharge_mwh", "soc_mwh", "export_mwh", "peak_target_mwh", "direct_peak_mwh"
    ]}
    ppa_energy_so_far = 0.0

    bess_by_node: Dict[int, List[int]] = {i: [] for i in range(len(node_names))}
    for i, n in enumerate(b_nodes):
        bess_by_node[int(n)].append(i)

    def reserve_by_battery(total_reserve: float) -> np.ndarray:
        if n_bess == 0 or b_max_soc.sum() <= 1e-9:
            return np.zeros(n_bess, dtype=float)
        reserve = min(max(0.0, total_reserve), float(b_max_soc.sum()))
        return reserve * b_max_soc / max(float(b_max_soc.sum()), 1e-9)

    def charge_from_re(re_node: np.ndarray, target_soc: Optional[np.ndarray] = None) -> float:
        charge_total = 0.0
        for n_idx in range(len(node_names)):
            if re_node[n_idx] <= 1e-9:
                continue
            for b_idx in bess_by_node.get(n_idx, []):
                soc_limit = b_max_soc[b_idx] if target_soc is None else min(b_max_soc[b_idx], target_soc[b_idx])
                empty_deliverable = max(0.0, soc_limit - soc[b_idx])
                if empty_deliverable <= 1e-9:
                    continue
                charge_ac = min(re_node[n_idx], b_charge_p[b_idx], empty_deliverable / max(b_rte[b_idx], 1e-9))
                if charge_ac <= 1e-9:
                    continue
                soc[b_idx] += charge_ac * b_rte[b_idx]
                re_node[n_idx] -= charge_ac
                charge_total += charge_ac
                if re_node[n_idx] <= 1e-9:
                    break
        return charge_total

    for t in range(HOURS_PER_YEAR):
        re_node = np.maximum(node_gen[t, :].copy(), 0.0)
        node_headroom = node_limits.copy()
        target = float(peak_target[t])
        out["peak_target_mwh"][t] = target

        if target > 0.0:
            direct_available = np.minimum(re_node, node_limits)
            direct_total_available = float(direct_available.sum())
            if direct_total_available <= target + 1e-9:
                direct = direct_available
            elif direct_total_available > 0:
                direct = direct_available * (target / direct_total_available)
            else:
                direct = np.zeros_like(re_node)
            direct = np.minimum(direct, re_node)
            re_node -= direct
            node_headroom = np.maximum(node_limits - direct, 0.0)
            direct_to_ppa = float(direct.sum())
            deficit = max(0.0, target - direct_to_ppa)
            discharge_total = 0.0

            if deficit > 1e-9 and n_bess:
                # Dispatch high-SOC batteries first, respecting local node headroom.
                order = np.argsort(-soc)
                for b_idx in order:
                    n_idx = int(b_nodes[b_idx])
                    available = min(b_discharge_p[b_idx], soc[b_idx], node_headroom[n_idx], deficit)
                    if available <= 1e-9:
                        continue
                    soc[b_idx] -= available
                    node_headroom[n_idx] -= available
                    deficit -= available
                    discharge_total += available
                    if deficit <= 1e-9:
                        break

            # Charge batteries from remaining RE behind the same node; this preserves RE-only charging.
            charge_total = charge_from_re(re_node)

            merchant_node = np.minimum(re_node, node_headroom)
            merchant = float(merchant_node.sum())
            spill = float(np.maximum(re_node - merchant_node, 0.0).sum())
            ppa_peak = direct_to_ppa + discharge_total
            ppa_energy_so_far += ppa_peak

            out["direct_peak_mwh"][t] = direct_to_ppa
            out["ppa_peak_mwh"][t] = ppa_peak
            out["bess_discharge_mwh"][t] = discharge_total
            out["bess_charge_mwh"][t] = charge_total
            out["merchant_mwh"][t] = merchant * (1.0 - sim.merchant_curtailment_haircut)
            out["spill_mwh"][t] = spill + merchant * sim.merchant_curtailment_haircut
            out["export_mwh"][t] = ppa_peak + out["merchant_mwh"][t]
            out["soc_mwh"][t] = float(soc.sum())
            continue

        if rules.reserve_ppa_cap_for_future_peak:
            remaining_cap_for_nonpeak = max(0.0, ppa_cap_mwh - ppa_energy_so_far - peak_remaining[t])
        else:
            remaining_cap_for_nonpeak = max(0.0, ppa_cap_mwh - ppa_energy_so_far)
        nonpeak_limit = rules.contracted_capacity_mw
        nonpeak_target = min(nonpeak_limit, remaining_cap_for_nonpeak)

        soc_before_charge = soc.copy()
        reserve_soc = np.maximum(
            reserve_by_battery(next_peak_reserve[t]),
            b_max_soc * max(0.0, min(1.0, sim.nonpeak_discharge_soc_reserve_fraction)),
        )
        charge_total = charge_from_re(re_node)

        exportable_node = np.minimum(re_node, node_limits)
        exportable = float(exportable_node.sum())
        spill = float(np.maximum(re_node - exportable_node, 0.0).sum())
        ppa_nonpeak_direct = min(exportable * rules.ppa_non_peak_take_fraction, nonpeak_target)
        merchant = max(0.0, exportable - ppa_nonpeak_direct)
        node_headroom = np.maximum(node_limits - exportable_node, 0.0)

        discharge_total = 0.0
        deficit = max(0.0, nonpeak_target - ppa_nonpeak_direct)
        if deficit > 1e-9 and n_bess:
            order = np.argsort(-(soc_before_charge - reserve_soc))
            for b_idx in order:
                n_idx = int(b_nodes[b_idx])
                # Use only SOC already above the next-peak reserve at the start
                # of this hour.  Fresh charging is held for reliability rather
                # than immediately round-tripped into non-peak PPA.
                available_soc = max(0.0, min(soc[b_idx], soc_before_charge[b_idx]) - reserve_soc[b_idx])
                available = min(b_discharge_p[b_idx], available_soc, node_headroom[n_idx], deficit)
                if available <= 1e-9:
                    continue
                soc[b_idx] -= available
                node_headroom[n_idx] -= available
                deficit -= available
                discharge_total += available
                if deficit <= 1e-9:
                    break

        ppa_nonpeak = ppa_nonpeak_direct + discharge_total
        ppa_energy_so_far += ppa_nonpeak

        out["ppa_nonpeak_mwh"][t] = ppa_nonpeak
        out["bess_charge_mwh"][t] = charge_total
        out["bess_discharge_mwh"][t] = discharge_total
        out["merchant_mwh"][t] = merchant * (1.0 - sim.merchant_curtailment_haircut)
        out["spill_mwh"][t] = spill + merchant * sim.merchant_curtailment_haircut
        out["export_mwh"][t] = ppa_nonpeak + out["merchant_mwh"][t]
        out["soc_mwh"][t] = float(soc.sum())

    return out, soc


def dispatch_project_year(project: ProjectConfig, year: int = 1,
                          custom_cf: Optional[pd.DataFrame] = None,
                          return_hourly: bool = False) -> DispatchResult:
    profile = generation_profile(project, year=year, custom_cf=custom_cf)
    peak_target = build_peak_target(project, profile)
    _, _, _, b_max_soc, _, _ = _bess_arrays(project, year)
    initial_soc = b_max_soc * project.simulation.initial_soc_fraction
    n_iter = max(1, int(project.simulation.circular_soc_iterations))
    out: Dict[str, np.ndarray] = {}
    ending_soc = initial_soc.copy()
    for _ in range(n_iter):
        out, ending_soc = _simulate_dispatch_pass(project, profile, peak_target, year, ending_soc)
    # Final pass from converged ending SOC for reporting.
    out, ending_soc = _simulate_dispatch_pass(project, profile, peak_target, year, ending_soc)

    ppa_peak = out["ppa_peak_mwh"]
    ppa_nonpeak = out["ppa_nonpeak_mwh"]
    ppa_before_green = ppa_peak.sum() + ppa_nonpeak.sum()
    peak_target_month = np.bincount(MONTH_OF_HOUR, weights=peak_target, minlength=12)
    peak_delivered_month = np.bincount(MONTH_OF_HOUR, weights=ppa_peak, minlength=12)
    peak_floor_month = project.tender.peak_availability_floor * peak_target_month
    peak_shortfall_month_before_green = np.maximum(0.0, peak_floor_month - peak_delivered_month)

    annual_min_mwh = project.tender.annual_min_mwh
    annual_shortfall_before_green = max(0.0, annual_min_mwh - ppa_before_green)
    green_available = 0.0
    green_for_peak = np.zeros(12, dtype=float)
    green_for_annual = 0.0
    if project.tender.allow_external_green_purchase:
        green_available = project.tender.external_green_limit_fraction * max(annual_min_mwh, ppa_before_green)
        remaining_green = green_available
        # Prioritize monthly peak compliance because both penalties can apply.
        for m in range(12):
            g = min(peak_shortfall_month_before_green[m], remaining_green)
            green_for_peak[m] = g
            remaining_green -= g
            if remaining_green <= 1e-9:
                break
        annual_shortfall_after_peak_green = max(0.0, annual_min_mwh - (ppa_before_green + green_for_peak.sum()))
        green_for_annual = min(annual_shortfall_after_peak_green, remaining_green)

    peak_shortfall_month = np.maximum(0.0, peak_shortfall_month_before_green - green_for_peak)
    green_total = float(green_for_peak.sum() + green_for_annual)
    ppa_after_green = ppa_before_green + green_total
    annual_shortfall = max(0.0, annual_min_mwh - ppa_after_green)
    peak_penalty_mwh = float(peak_shortfall_month.sum())
    annual_penalty_mwh = float(annual_shortfall)

    monthly = pd.DataFrame({
        "month": np.arange(1, 13),
        "peak_obligation_mwh": peak_target_month,
        "peak_floor_mwh": peak_floor_month,
        "peak_delivered_mwh": peak_delivered_month,
        "external_green_mwh": green_for_peak,
        "peak_shortfall_mwh": peak_shortfall_month,
        "peak_availability": np.divide(peak_delivered_month + green_for_peak, peak_target_month,
                                       out=np.ones_like(peak_target_month), where=peak_target_month > 0),
    })
    monthly["compliant"] = monthly["peak_availability"] + 1e-9 >= project.tender.peak_availability_floor

    total_re = float(profile["total_re_mw"].sum())
    summary = {
        "year": float(year),
        "contracted_capacity_mw": project.tender.contracted_capacity_mw,
        "declared_cuf": project.tender.declared_annual_cuf,
        "annual_cuf_floor": project.tender.annual_cuf_floor,
        "annual_cuf_ceiling": project.tender.annual_cuf_ceiling,
        "annual_min_mwh": annual_min_mwh,
        "annual_ppa_cap_mwh": project.tender.annual_ppa_cap_mwh,
        "ppa_peak_mwh": float(ppa_peak.sum()),
        "ppa_nonpeak_mwh": float(ppa_nonpeak.sum()),
        "ppa_mwh_before_green": float(ppa_before_green),
        "external_green_mwh": green_total,
        "ppa_mwh": float(ppa_after_green),
        "merchant_mwh": float(out["merchant_mwh"].sum()),
        "spill_mwh": float(out["spill_mwh"].sum()),
        "bess_charge_mwh": float(out["bess_charge_mwh"].sum()),
        "bess_discharge_mwh": float(out["bess_discharge_mwh"].sum()),
        "total_re_mwh": total_re,
        "peak_obligation_mwh": float(peak_target.sum()),
        "peak_delivered_mwh": float(ppa_peak.sum() + green_for_peak.sum()),
        "peak_penalty_mwh": peak_penalty_mwh,
        "annual_penalty_mwh": annual_penalty_mwh,
        "total_penalty_mwh": peak_penalty_mwh + annual_penalty_mwh,
        "annual_cuf": float(ppa_after_green / max(project.tender.contracted_capacity_mw * project.tender.cuf_hours_per_year, 1e-9)),
        "annual_cuf_cap_utilization": float(ppa_after_green / max(project.tender.annual_ppa_cap_mwh, 1e-9)),
        "annual_cuf_upper_headroom_mwh": float(max(0.0, project.tender.annual_ppa_cap_mwh - ppa_after_green)),
        "annual_cuf_upper_excess_mwh": float(max(0.0, ppa_after_green - project.tender.annual_ppa_cap_mwh)),
        "min_monthly_peak_availability": float(monthly["peak_availability"].min()),
        "avg_soc_mwh": float(out["soc_mwh"].mean()),
        "ending_soc_mwh": float(ending_soc.sum()) if len(ending_soc) else 0.0,
    }

    hourly = None
    if return_hourly:
        hourly = profile.copy()
        for key, arr in out.items():
            hourly[key] = arr
        hourly["ppa_mwh"] = hourly["ppa_peak_mwh"] + hourly["ppa_nonpeak_mwh"]
        hourly["is_peak"] = peak_target > 0
    return DispatchResult(summary=summary, monthly=monthly, hourly=hourly)


def operating_case(project: ProjectConfig, years: Optional[Sequence[int]] = None,
                   custom_cf: Optional[pd.DataFrame] = None,
                   return_first_year_hourly: bool = True) -> Tuple[pd.DataFrame, DispatchResult]:
    if years is None:
        years = list(range(1, project.tender.ppa_years + 1))
    rows = []
    first_result: Optional[DispatchResult] = None
    for y in years:
        res = dispatch_project_year(project, year=int(y), custom_cf=custom_cf,
                                    return_hourly=(return_first_year_hourly and int(y) == int(years[0])))
        rows.append(res.summary)
        if first_result is None:
            first_result = res
    df = pd.DataFrame(rows).sort_values("year").reset_index(drop=True)
    # If snapshots are supplied, interpolate to the full PPA term.
    full_years = np.arange(1, project.tender.ppa_years + 1)
    if len(df) != project.tender.ppa_years or not np.array_equal(df["year"].to_numpy(dtype=int), full_years):
        interp = {"year": full_years}
        for col in df.columns:
            if col == "year":
                continue
            interp[col] = np.interp(full_years, df["year"].to_numpy(dtype=float), df[col].to_numpy(dtype=float))
        df = pd.DataFrame(interp)
    assert first_result is not None
    return df, first_result


# ---------------------------------------------------------------------------
# Capex and finance


def processing_fee_cr(contracted_capacity_mw: float, gst: float = 0.18) -> float:
    if contracted_capacity_mw <= 50:
        lakh = 3.0
    elif contracted_capacity_mw <= 100:
        lakh = 5.0
    elif contracted_capacity_mw <= 250:
        lakh = 10.0
    elif contracted_capacity_mw <= 500:
        lakh = 20.0
    else:
        lakh = 30.0
    return lakh * (1.0 + gst) / 100.0


def security_amounts_cr(project: ProjectConfig, project_count: int = 1) -> Tuple[float, float]:
    solar_mw = sum(g.ac_mw for g in project.generators if g.technology.lower() == "solar")
    wind_mw = sum(g.ac_mw for g in project.generators if g.technology.lower() == "wind")
    ess_mw = sum(b.power_mw for b in project.bess)
    emd_raw = 0.0928 * solar_mw + 0.1264 * wind_mw + 0.1464 * ess_mw
    emd = min(emd_raw, 10.0 * max(1, project_count))
    pbg = 0.2320 * solar_mw + 0.3160 * wind_mw + 0.3660 * ess_mw
    return emd, pbg


def capex_model(project: ProjectConfig) -> CapexResult:
    fin = project.finance
    components: Dict[str, float] = {}
    solar_capex = 0.0
    wind_capex = 0.0
    gen_opex_marker = 0.0  # not used, but keeps a useful audit convention
    for gen in project.generators:
        if gen.technology.lower() == "solar":
            unit = gen.capex_cr_per_mw or fin.default_solar_capex_cr_per_mw_ac
            solar_capex += gen.ac_mw * unit
        elif gen.technology.lower() == "wind":
            unit = gen.capex_cr_per_mw or fin.default_wind_capex_cr_per_mw
            wind_capex += gen.ac_mw * unit
        gen_opex_marker += gen.ac_mw
    solar_mw = sum(g.ac_mw for g in project.generators if g.technology.lower() == "solar")
    wind_mw = sum(g.ac_mw for g in project.generators if g.technology.lower() == "wind")
    bess_power_mw = sum(b.power_mw for b in project.bess)
    bess_energy_mwh = sum(b.energy_mwh for b in project.bess)
    interconnection_limit_mw = sum(n.interconnection_limit_mw for n in project.nodes)
    evacuation_basis_mw = max(project.tender.contracted_capacity_mw, solar_mw + wind_mw, bess_power_mw)
    if interconnection_limit_mw > 0:
        evacuation_basis_mw = min(evacuation_basis_mw, interconnection_limit_mw)
    owner_basis_mw = solar_mw + wind_mw + bess_power_mw
    bess_energy_capex = sum(b.energy_mwh * (b.capex_cr_per_mwh or fin.default_bess_capex_cr_per_mwh) for b in project.bess)
    bess_power_capex = sum(b.power_mw * (b.pcs_capex_cr_per_mw or fin.default_bess_pcs_capex_cr_per_mw) for b in project.bess)
    land_capex = (
        fin.land_and_development_cr
        + solar_mw * fin.land_solar_cr_per_mw_ac
        + wind_mw * fin.land_wind_cr_per_mw
        + bess_energy_mwh * fin.land_bess_cr_per_mwh
    )
    transmission_capex = fin.transmission_lump_sum_cr + evacuation_basis_mw * fin.transmission_cr_per_mw
    owner_costs = fin.owner_costs_cr + owner_basis_mw * fin.owner_costs_cr_per_mw
    success = (project.tender.contracted_capacity_mw * project.tender.success_charge_lakh_per_mw
               * (1.0 + project.tender.success_charge_gst) / 100.0)
    proc_fee = processing_fee_cr(project.tender.contracted_capacity_mw)
    components.update({
        "solar_epc_cr": solar_capex,
        "wind_epc_cr": wind_capex,
        "bess_energy_epc_cr": bess_energy_capex,
        "bess_power_pcs_cr": bess_power_capex,
        "land_and_development_cr": land_capex,
        "transmission_connectivity_cr": transmission_capex,
        "owner_costs_cr": owner_costs,
        "success_charge_cr": success,
        "processing_fee_cr": proc_fee,
    })
    base_before_cont = sum(components.values())
    components["contingency_cr"] = base_before_cont * fin.contingency_percent
    hard = sum(components.values())

    # Monthly IDC approximation based on construction drawdown proportions.
    months = max(1, fin.construction_months)
    draw = np.zeros(months)
    if len(fin.construction_drawdown) == 2 and months >= 2:
        first = months // 2
        draw[:first] = fin.construction_drawdown[0] / max(first, 1)
        draw[first:] = fin.construction_drawdown[1] / max(months - first, 1)
    else:
        draw[:] = 1.0 / months
    draw = draw / draw.sum()
    monthly_rate = (1.0 + fin.interest_rate) ** (1.0 / 12.0) - 1.0
    debt_base = hard * fin.debt_fraction
    outstanding = 0.0
    idc = 0.0
    for w in draw:
        outstanding += debt_base * w
        interest = outstanding * monthly_rate
        idc += interest
        # Assume IDC is capitalized and funded with the same debt/equity mix at COD.
    total = hard + idc
    debt = total * fin.debt_fraction
    equity = total - debt
    emd, pbg = security_amounts_cr(project, project_count=int(project.metadata.get("project_count", 1)))
    return CapexResult(components, hard, idc, total, debt, equity, emd, pbg)


def npv(rate: float, cashflows: Sequence[float]) -> float:
    c = np.asarray(cashflows, dtype=float)
    t = np.arange(len(c), dtype=float)
    return float(np.sum(c / (1.0 + rate) ** t))


def irr(cashflows: Sequence[float]) -> float:
    c = np.asarray(cashflows, dtype=float)
    if len(c) == 0 or not (np.any(c > 0) and np.any(c < 0)):
        return float("nan")
    def f(r: float) -> float:
        return npv(r, c)
    lo, hi = -0.95, 1.0
    flo, fhi = f(lo), f(hi)
    # Expand upper bound if needed.
    for _ in range(30):
        if flo * fhi <= 0:
            break
        hi = hi * 2.0 + 0.5
        fhi = f(hi)
    if flo * fhi > 0:
        return float("nan")
    for _ in range(100):
        mid = (lo + hi) / 2.0
        fm = f(mid)
        if flo * fm <= 0:
            hi = mid
            fhi = fm
        else:
            lo = mid
            flo = fm
    return float((lo + hi) / 2.0)


def annuity_payment(principal: float, rate: float, tenor: int) -> float:
    if principal <= 0 or tenor <= 0:
        return 0.0
    if abs(rate) < 1e-12:
        return principal / tenor
    return principal * rate / (1.0 - (1.0 + rate) ** (-tenor))


def _debt_schedule_annuity(debt: float, rate: float, tenor: int, n_years: int) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    ds = np.zeros(n_years, dtype=float)
    interest = np.zeros(n_years, dtype=float)
    principal = np.zeros(n_years, dtype=float)
    outstanding = max(0.0, float(debt))
    payment = annuity_payment(outstanding, rate, tenor)
    for i in range(n_years):
        if i < tenor and outstanding > 1e-9:
            interest[i] = outstanding * rate
            principal[i] = max(0.0, min(outstanding, payment - interest[i]))
            ds[i] = interest[i] + principal[i]
            outstanding -= principal[i]
    return ds, interest, principal


def _debt_schedule_sculpted(debt: float, rate: float, tenor: int, cfads: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    n_years = len(cfads)
    ds = np.zeros(n_years, dtype=float)
    interest = np.zeros(n_years, dtype=float)
    principal = np.zeros(n_years, dtype=float)
    debt = max(0.0, float(debt))
    if debt <= 1e-9 or tenor <= 0:
        return ds, interest, principal
    tenor = min(int(tenor), n_years)
    cfads_debt = np.maximum(np.asarray(cfads[:tenor], dtype=float), 0.0)
    discount = (1.0 + rate) ** np.arange(1, tenor + 1)
    pv_cfads = float(np.sum(cfads_debt / discount))
    if pv_cfads <= 1e-9:
        return ds, interest, principal
    constant_dscr = max(pv_cfads / debt, 1e-9)
    target_ds = cfads_debt / constant_dscr
    outstanding = debt
    for i in range(tenor):
        if outstanding <= 1e-9:
            break
        interest[i] = outstanding * rate
        principal[i] = max(0.0, min(outstanding, target_ds[i] - interest[i]))
        ds[i] = interest[i] + principal[i]
        outstanding -= principal[i]
    if outstanding > 1e-6:
        principal[tenor - 1] += outstanding
        ds[tenor - 1] += outstanding
    return ds, interest, principal


def _debt_capacity_from_cfads(cfads: np.ndarray, rate: float, tenor: int, target_dscr: float) -> float:
    tenor = min(max(0, int(tenor)), len(cfads))
    if tenor <= 0:
        return 0.0
    target = max(float(target_dscr), 1e-9)
    debt_cfads = np.maximum(np.asarray(cfads[:tenor], dtype=float), 0.0)
    discount = (1.0 + rate) ** np.arange(1, tenor + 1)
    return float(np.sum((debt_cfads / target) / discount))


def augmentation_by_year(project: ProjectConfig) -> np.ndarray:
    n = project.tender.ppa_years
    fin = project.finance
    aug = np.zeros(n, dtype=float)
    total_bess_energy = sum(b.energy_mwh for b in project.bess)
    for item in fin.bess_augmentation_schedule:
        y = int(item.get("year", 0))
        if 1 <= y <= n:
            frac = _as_float(item.get("energy_replacement_fraction"), 0.0)
            cost = _as_float(item.get("cost_cr_per_mwh"), fin.default_bess_capex_cr_per_mwh)
            aug[y - 1] += total_bess_energy * frac * cost
    return aug


def financial_model(project: ProjectConfig, operating: pd.DataFrame, tariff_rs_per_kwh: float) -> FinanceResult:
    fin = project.finance
    n = project.tender.ppa_years
    op = operating.iloc[:n].copy().reset_index(drop=True)
    cap = capex_model(project)
    years = np.arange(1, n + 1)
    escalation = (1.0 + fin.opex_escalation) ** (years - 1)
    merchant_price = project.simulation.merchant_price_rs_per_kwh * (1.0 + project.simulation.merchant_escalation) ** (years - 1)
    ppa_tariff_net = max(0.0, tariff_rs_per_kwh - project.tender.psm_charge_rs_per_kwh)
    rev_ppa = op["ppa_mwh"].to_numpy(float) * ppa_tariff_net / 10000.0
    rev_merchant = op["merchant_mwh"].to_numpy(float) * merchant_price / 10000.0
    penalty_mwh = op["total_penalty_mwh"].to_numpy(float)
    penalty = penalty_mwh * project.tender.penalty_multiplier * tariff_rs_per_kwh / 10000.0
    green_cost = op["external_green_mwh"].to_numpy(float) * project.tender.external_green_price_rs_per_kwh / 10000.0
    revenue = rev_ppa + rev_merchant - penalty - green_cost

    gen_opex = 0.0
    for gen in project.generators:
        unit = gen.opex_lakh_per_mw_year or (
            fin.default_solar_opex_lakh_per_mw_year if gen.technology.lower() == "solar" else fin.default_wind_opex_lakh_per_mw_year
        )
        gen_opex += gen.ac_mw * unit / 100.0
    bess_opex = sum(b.energy_mwh * (b.opex_lakh_per_mwh_year or fin.default_bess_opex_lakh_per_mwh_year) / 100.0 for b in project.bess)
    solar_mw = sum(g.ac_mw for g in project.generators if g.technology.lower() == "solar")
    wind_mw = sum(g.ac_mw for g in project.generators if g.technology.lower() == "wind")
    bess_power_mw = sum(b.power_mw for b in project.bess)
    interconnection_limit_mw = sum(n.interconnection_limit_mw for n in project.nodes)
    evacuation_basis_mw = max(project.tender.contracted_capacity_mw, solar_mw + wind_mw, bess_power_mw)
    if interconnection_limit_mw > 0:
        evacuation_basis_mw = min(evacuation_basis_mw, interconnection_limit_mw)
    owner_basis_mw = solar_mw + wind_mw + bess_power_mw
    admin_opex = fin.admin_opex_cr_year + owner_basis_mw * fin.admin_opex_lakh_per_mw_year / 100.0
    transmission_opex = evacuation_basis_mw * fin.transmission_opex_lakh_per_mw_year / 100.0
    transmission_loss_cost = op["ppa_mwh"].to_numpy(float) * ppa_tariff_net * (fin.transmission_loss_percent / 100.0) / 10000.0
    fixed_opex = (gen_opex + bess_opex + admin_opex + transmission_opex) * escalation
    insurance = cap.hard_capex_cr * fin.insurance_percent_hard_capex * np.ones(n)
    wc_interest = np.maximum(revenue, 0.0) * fin.receivable_days / 365.0 * fin.working_capital_interest_rate
    opex = fixed_opex + insurance + wc_interest + transmission_loss_cost
    ebitda = revenue - opex

    aug = augmentation_by_year(project)
    book_dep = np.full(n, cap.total_project_cost_cr * (1.0 - fin.residual_value_fraction) / max(fin.book_depreciation_years, 1))
    for i, a in enumerate(aug):
        if a > 0 and i < n:
            book_dep[i:] += a * (1.0 - fin.residual_value_fraction) / max(n - i, 1)

    receivables = np.maximum(revenue, 0.0) * fin.receivable_days / 365.0
    delta_wc = np.diff(receivables, prepend=0.0)

    def tax_for_interest(interest_vector: np.ndarray) -> np.ndarray:
        tax_out = np.zeros(n, dtype=float)
        tax_wdv_open = cap.total_project_cost_cr * fin.tax_depreciable_basis_fraction
        slm_non_eligible = cap.total_project_cost_cr * (1.0 - fin.tax_depreciable_basis_fraction) / max(fin.book_depreciation_years, 1)
        loss_bf = 0.0
        for i in range(n):
            if aug[i] > 0:
                tax_wdv_open += aug[i] * fin.tax_depreciable_basis_fraction
            tax_dep = tax_wdv_open * fin.tax_wdv_rate + slm_non_eligible
            tax_wdv_open = max(0.0, tax_wdv_open - tax_wdv_open * fin.tax_wdv_rate)
            taxable = ebitda[i] - interest_vector[i] - tax_dep
            taxable_after_loss = taxable - loss_bf
            if taxable_after_loss > 0:
                tax_out[i] = taxable_after_loss * fin.tax_rate
                loss_bf = 0.0
            else:
                tax_out[i] = 0.0
                loss_bf = -taxable_after_loss
        return tax_out

    requested_debt = cap.debt_cr
    actual_debt = requested_debt
    ds = np.zeros(n, dtype=float)
    interest = np.zeros(n, dtype=float)
    principal = np.zeros(n, dtype=float)
    tax = tax_for_interest(interest)
    cfads = ebitda - tax - delta_wc
    style = str(getattr(fin, "repayment_style", "sculpted")).lower()
    for _ in range(25):
        if getattr(fin, "size_debt_by_dscr", True) and requested_debt > 1e-9:
            capacity = _debt_capacity_from_cfads(
                cfads,
                fin.interest_rate,
                fin.debt_tenor_years,
                getattr(fin, "sculpt_target_dscr", fin.min_dscr),
            )
            next_debt = min(requested_debt, max(0.0, capacity))
        else:
            next_debt = requested_debt
        if style == "annuity":
            next_ds, next_interest, next_principal = _debt_schedule_annuity(next_debt, fin.interest_rate, fin.debt_tenor_years, n)
        else:
            next_ds, next_interest, next_principal = _debt_schedule_sculpted(next_debt, fin.interest_rate, fin.debt_tenor_years, cfads)
        next_tax = tax_for_interest(next_interest)
        next_cfads = ebitda - next_tax - delta_wc
        if (
            abs(next_debt - actual_debt) <= 1e-7
            and np.max(np.abs(next_interest - interest)) <= 1e-7
            and np.max(np.abs(next_tax - tax)) <= 1e-7
        ):
            actual_debt = next_debt
            ds, interest, principal = next_ds, next_interest, next_principal
            tax, cfads = next_tax, next_cfads
            break
        actual_debt = next_debt
        ds, interest, principal = next_ds, next_interest, next_principal
        tax, cfads = next_tax, next_cfads

    cap = replace(cap, debt_cr=actual_debt, equity_cr=cap.total_project_cost_cr - actual_debt)
    cfads = ebitda - tax - delta_wc
    fcfe = cfads - ds - aug
    fcfe[-1] += fin.terminal_value_cr
    project_cf = cfads - aug
    project_cf[-1] += fin.terminal_value_cr

    # Construction equity drawdown is split according to construction_drawdown.
    draw = np.asarray(fin.construction_drawdown, dtype=float)
    if draw.size == 0 or draw.sum() <= 0:
        draw = np.array([1.0])
    draw = draw / draw.sum()
    equity_outflows = -cap.equity_cr * draw
    project_outflows = -cap.total_project_cost_cr * draw
    equity_cashflows = np.concatenate([equity_outflows, fcfe])
    project_cashflows = np.concatenate([project_outflows, project_cf])

    debt_years = ds > 1e-9
    dscr = np.divide(cfads, ds, out=np.full(n, np.inf), where=debt_years)
    post_aug_dscr = np.divide(cfads - aug, ds, out=np.full(n, np.inf), where=debt_years)
    table = pd.DataFrame({
        "year": years,
        "ppa_mwh": op["ppa_mwh"].to_numpy(float),
        "merchant_mwh": op["merchant_mwh"].to_numpy(float),
        "peak_penalty_mwh": op["peak_penalty_mwh"].to_numpy(float),
        "annual_penalty_mwh": op["annual_penalty_mwh"].to_numpy(float),
        "revenue_ppa_cr": rev_ppa,
        "revenue_merchant_cr": rev_merchant,
        "penalty_cr": penalty,
        "green_cost_cr": green_cost,
        "revenue_net_cr": revenue,
        "opex_cr": opex,
        "ebitda_cr": ebitda,
        "interest_cr": interest,
        "principal_cr": principal,
        "debt_service_cr": ds,
        "book_dep_cr": book_dep,
        "tax_cr": tax,
        "augmentation_cr": aug,
        "cfads_cr": cfads,
        "fcfe_cr": fcfe,
        "dscr": dscr,
        "post_aug_dscr": post_aug_dscr,
        "annual_cuf": op["annual_cuf"].to_numpy(float),
        "min_monthly_peak_availability": op["min_monthly_peak_availability"].to_numpy(float),
    })
    if np.any(debt_years):
        min_dscr = float(np.nanmin(dscr[debt_years]))
        avg_dscr = float(np.nanmean(dscr[debt_years]))
    else:
        min_dscr = float("inf")
        avg_dscr = float("inf")
    return FinanceResult(
        tariff_rs_per_kwh=float(tariff_rs_per_kwh),
        equity_irr=irr(equity_cashflows),
        project_irr=irr(project_cashflows),
        min_dscr=min_dscr,
        avg_dscr=avg_dscr,
        npv_equity_cr=npv(fin.discount_rate, equity_cashflows),
        capex=cap,
        table=table,
        equity_cashflows=equity_cashflows,
        project_cashflows=project_cashflows,
    )


def physical_compliance(project: ProjectConfig, operating: pd.DataFrame) -> Dict[str, Any]:
    peak_ok = bool((operating["peak_penalty_mwh"].abs() <= 1e-6).all())
    annual_ok = bool((operating["annual_penalty_mwh"].abs() <= 1e-6).all())
    annual_upper_ok = bool((operating["annual_cuf"] <= project.tender.annual_cuf_ceiling + 1e-9).all())
    return {
        "peak_ok": peak_ok,
        "annual_cuf_ok": annual_ok,
        "annual_cuf_upper_ok": annual_upper_ok,
        "total_penalty_mwh": float(operating["total_penalty_mwh"].sum()),
        "min_monthly_peak_availability": float(operating["min_monthly_peak_availability"].min()),
        "min_annual_cuf": float(operating["annual_cuf"].min()),
        "max_annual_cuf": float(operating["annual_cuf"].max()),
        "annual_cuf_floor": float(project.tender.annual_cuf_floor),
        "annual_cuf_ceiling": float(project.tender.annual_cuf_ceiling),
    }


def required_tariff(project: ProjectConfig, operating: pd.DataFrame,
                    low: float = 0.50, high: float = 20.0) -> Tuple[float, Optional[FinanceResult], Dict[str, Any]]:
    comp = physical_compliance(project, operating)
    if project.finance.hard_compliance_required:
        if project.tender.hard_monthly_peak_compliance and not comp["peak_ok"]:
            return float("nan"), None, {**comp, "reason": "monthly peak availability shortfall"}
        if project.tender.hard_annual_cuf_compliance and not comp["annual_cuf_ok"]:
            return float("nan"), None, {**comp, "reason": "annual CUF shortfall"}

    def passes(tariff: float) -> Tuple[bool, FinanceResult]:
        fin = financial_model(project, operating, tariff)
        ok_irr = np.isfinite(fin.equity_irr) and fin.equity_irr >= project.finance.target_equity_irr
        ok_dscr = fin.capex.debt_cr <= 1e-6 or fin.min_dscr >= project.finance.min_dscr
        return bool(ok_irr and ok_dscr), fin

    ok_high, fin_high = passes(high)
    grow_count = 0
    while not ok_high and high < 100.0 and grow_count < 8:
        high *= 1.5
        ok_high, fin_high = passes(high)
        grow_count += 1
    if not ok_high:
        return float("nan"), fin_high, {**comp, "reason": "target IRR/DSCR not met at high tariff"}

    fin_mid: Optional[FinanceResult] = None
    for _ in range(60):
        mid = (low + high) / 2.0
        ok_mid, fin_mid = passes(mid)
        if ok_mid:
            high = mid
        else:
            low = mid
    final_fin = financial_model(project, operating, high)
    return float(high), final_fin, {**comp, "reason": "ok"}


# ---------------------------------------------------------------------------
# Sizing optimizer


def _generator_capacity_key(gen: GeneratorSpec) -> str:
    return f"gen_{_safe_name(gen.name)}_ac_mw"


def scale_project(project: ProjectConfig, wind_mw: Optional[float] = None,
                  solar_ac_mw: Optional[float] = None,
                  bess_power_mw: Optional[float] = None,
                  bess_energy_mwh: Optional[float] = None,
                  contracted_capacity_mw: Optional[float] = None,
                  generator_ac_mw: Optional[Mapping[str, float]] = None,
                  **capacity_overrides: float) -> ProjectConfig:
    p = copy.deepcopy(project)
    if contracted_capacity_mw is not None:
        p.tender.contracted_capacity_mw = float(contracted_capacity_mw)
    current_wind = sum(g.ac_mw for g in p.generators if g.technology.lower() == "wind")
    current_solar = sum(g.ac_mw for g in p.generators if g.technology.lower() == "solar")
    current_bp = sum(b.power_mw for b in p.bess)
    current_be = sum(b.energy_mwh for b in p.bess)

    def scaled_generators(technology: str, target_mw: Optional[float], current_mw: float) -> List[GeneratorSpec]:
        gens = [g for g in p.generators if g.technology.lower() == technology]
        if target_mw is None or not gens:
            return gens
        target = float(target_mw)
        if current_mw > 0:
            scale = target / current_mw
            return [g.clone_scaled(scale) for g in gens]
        per_gen = target / len(gens)
        rebuilt: List[GeneratorSpec] = []
        for g in gens:
            dc_ac = (g.dc_mwp / g.ac_mw) if g.ac_mw > 0 and g.dc_mwp > 0 else (1.5 if technology == "solar" else 0.0)
            rebuilt.append(replace(g, ac_mw=per_gen, dc_mwp=per_gen * dc_ac))
        return rebuilt

    scaled_by_name = {
        g.name: g
        for group in (
            scaled_generators("wind", wind_mw, current_wind),
            scaled_generators("solar", solar_ac_mw, current_solar),
        )
        for g in group
    }
    p.generators = [scaled_by_name.get(g.name, g) for g in p.generators]

    def scale_bess_zero_safe(b: BessSpec) -> BessSpec:
        power = b.power_mw
        charge_power = b.charge_power_mw
        discharge_power = b.discharge_power_mw
        energy = b.energy_mwh
        usable = b.usable_mwh_at_poi
        if bess_power_mw is not None:
            if current_bp > 0:
                power_scale = float(bess_power_mw) / current_bp
                power = b.power_mw * power_scale
                charge_power = None if b.charge_power_mw is None else b.charge_power_mw * power_scale
                discharge_power = None if b.discharge_power_mw is None else b.discharge_power_mw * power_scale
            elif p.bess:
                power = float(bess_power_mw) / len(p.bess)
                charge_power = None
                discharge_power = None
        if bess_energy_mwh is not None:
            if current_be > 0:
                energy_scale = float(bess_energy_mwh) / current_be
                energy = b.energy_mwh * energy_scale
                usable = b.usable_mwh_at_poi * energy_scale
                energy_augmentation_schedule = [
                    {
                        **item,
                        "energy_mwh": float(item.get("energy_mwh", 0.0)) * energy_scale,
                        "usable_mwh_at_poi": float(item.get("usable_mwh_at_poi", 0.0)) * energy_scale,
                    }
                    for item in b.energy_augmentation_schedule
                ]
            elif p.bess:
                energy = float(bess_energy_mwh) / len(p.bess)
                usable_ratio = (b.usable_mwh_at_poi / b.energy_mwh) if b.energy_mwh > 0 else 0.95
                usable = energy * usable_ratio
                energy_augmentation_schedule = b.energy_augmentation_schedule
        else:
            energy_augmentation_schedule = b.energy_augmentation_schedule
        return replace(
            b,
            power_mw=power,
            charge_power_mw=charge_power,
            discharge_power_mw=discharge_power,
            energy_mwh=energy,
            usable_mwh_at_poi=usable,
            energy_augmentation_schedule=energy_augmentation_schedule,
        )

    p.bess = [scale_bess_zero_safe(b) for b in p.bess]
    generator_targets = {str(k).lower(): float(v) for k, v in dict(generator_ac_mw or {}).items()}
    for key, value in capacity_overrides.items():
        if key.startswith("gen_") and key.endswith("_ac_mw"):
            generator_targets[key[4:-6].lower()] = float(value)
    for gen in p.generators:
        safe = _safe_name(gen.name)
        if safe in generator_targets:
            target_mw = float(generator_targets[safe])
            ratio = target_mw / gen.ac_mw if gen.ac_mw > 0 else 1.0
            gen.ac_mw = target_mw
            gen.dc_mwp *= ratio
    # Scale node limits for nodes that were originally driven by a scaled plant only if explicitly requested by metadata.
    return p


def _capacity_seed_highs(project: ProjectConfig,
                         bounds: Mapping[str, Tuple[float, float]],
                         keys: Sequence[str],
                         custom_cf: Optional[pd.DataFrame] = None) -> Optional[np.ndarray]:
    """Build a deterministic capacity seed with SciPy/HiGHS.

    The full tariff problem is nonlinear because it includes dispatch, taxes,
    IRR and DSCR.  This LP gives the stochastic search a sober starting point:
    lowest proxy capex that clears high-level annual-energy, peak-power and
    BESS-duration constraints within the selected bounds.
    """
    try:
        idx = {k: i for i, k in enumerate(keys)}
        n = len(keys)
        lower = np.asarray([bounds[k][0] for k in keys], dtype=float)
        upper = np.asarray([bounds[k][1] for k in keys], dtype=float)
        cap = project_capacity_summary(project)

        def current_or_bound(name: str) -> float:
            if name in idx:
                return 0.0
            return float(cap.get(name, 0.0))

        cc_const = current_or_bound("contracted_capacity_mw")
        c = np.zeros(n, dtype=float)
        gen_key_map = {_generator_capacity_key(g): g for g in project.generators}
        if "wind_mw" in idx:
            c[idx["wind_mw"]] = project.finance.default_wind_capex_cr_per_mw
        if "solar_ac_mw" in idx:
            c[idx["solar_ac_mw"]] = project.finance.default_solar_capex_cr_per_mw_ac
        for key, gen in gen_key_map.items():
            if key in idx:
                default_capex = (project.finance.default_solar_capex_cr_per_mw_ac
                                 if gen.technology.lower() == "solar"
                                 else project.finance.default_wind_capex_cr_per_mw)
                c[idx[key]] = gen.capex_cr_per_mw or default_capex
        if "bess_power_mw" in idx:
            c[idx["bess_power_mw"]] = project.finance.default_bess_pcs_capex_cr_per_mw
        if "bess_energy_mwh" in idx:
            c[idx["bess_energy_mwh"]] = project.finance.default_bess_capex_cr_per_mwh
        if "contracted_capacity_mw" in idx:
            # Prefer not to over-bid capacity when the rest of the LP is indifferent.
            c[idx["contracted_capacity_mw"]] = 0.01

        a_ub: List[np.ndarray] = []
        b_ub: List[float] = []

        solar_gens = [g for g in project.generators if g.technology.lower() == "solar"]
        wind_gens = [g for g in project.generators if g.technology.lower() == "wind"]
        solar_cuf = (sum(g.cuf * g.ac_mw for g in solar_gens) / cap["solar_ac_mw"]) if cap["solar_ac_mw"] > 0 else 0.0
        wind_cuf = (sum(g.cuf * g.ac_mw for g in wind_gens) / cap["wind_mw"]) if cap["wind_mw"] > 0 else 0.0
        has_individual_solar = any(_generator_capacity_key(g) in idx for g in solar_gens)
        has_individual_wind = any(_generator_capacity_key(g) in idx for g in wind_gens)
        annual_floor = project.tender.annual_cuf_floor * project.tender.cuf_hours_per_year
        row = np.zeros(n, dtype=float)
        rhs = -annual_floor * cc_const
        if "solar_ac_mw" in idx:
            row[idx["solar_ac_mw"]] = -solar_cuf * project.tender.cuf_hours_per_year
        elif has_individual_solar:
            for g in solar_gens:
                key = _generator_capacity_key(g)
                if key in idx:
                    row[idx[key]] = -g.cuf * project.tender.cuf_hours_per_year
                else:
                    rhs += g.cuf * project.tender.cuf_hours_per_year * g.ac_mw
        else:
            rhs += solar_cuf * project.tender.cuf_hours_per_year * cap["solar_ac_mw"]
        if "wind_mw" in idx:
            row[idx["wind_mw"]] = -wind_cuf * project.tender.cuf_hours_per_year
        elif has_individual_wind:
            for g in wind_gens:
                key = _generator_capacity_key(g)
                if key in idx:
                    row[idx[key]] = -g.cuf * project.tender.cuf_hours_per_year
                else:
                    rhs += g.cuf * project.tender.cuf_hours_per_year * g.ac_mw
        else:
            rhs += wind_cuf * project.tender.cuf_hours_per_year * cap["wind_mw"]
        if "contracted_capacity_mw" in idx:
            row[idx["contracted_capacity_mw"]] = annual_floor
        a_ub.append(row)
        b_ub.append(rhs)

        profile = generation_profile(project, year=1, custom_cf=custom_cf)
        peak_target = build_peak_target(project, profile) > 0
        solar_peak_per_mw = 0.0
        wind_peak_per_mw = 0.0
        gen_peak_per_mw: Dict[str, float] = {}
        if peak_target.any():
            solar_cols = [f"gen_{_safe_name(g.name)}" for g in project.generators if g.technology.lower() == "solar"]
            wind_cols = [f"gen_{_safe_name(g.name)}" for g in project.generators if g.technology.lower() == "wind"]
            for g in project.generators:
                col = f"gen_{_safe_name(g.name)}"
                if col in profile.columns and g.ac_mw > 0:
                    gen_peak_per_mw[_generator_capacity_key(g)] = float(profile.loc[peak_target, col].mean() / g.ac_mw)
            if solar_cols and cap["solar_ac_mw"] > 0:
                solar_peak_per_mw = float(profile.loc[peak_target, solar_cols].sum(axis=1).mean() / cap["solar_ac_mw"])
            if wind_cols and cap["wind_mw"] > 0:
                wind_peak_per_mw = float(profile.loc[peak_target, wind_cols].sum(axis=1).mean() / cap["wind_mw"])
        row = np.zeros(n, dtype=float)
        rhs = -project.tender.peak_availability_floor * cc_const
        if "solar_ac_mw" in idx:
            row[idx["solar_ac_mw"]] = -solar_peak_per_mw
        elif has_individual_solar:
            for g in solar_gens:
                key = _generator_capacity_key(g)
                if key in idx:
                    row[idx[key]] = -gen_peak_per_mw.get(key, 0.0)
                else:
                    rhs += gen_peak_per_mw.get(key, 0.0) * g.ac_mw
        else:
            rhs += solar_peak_per_mw * cap["solar_ac_mw"]
        if "wind_mw" in idx:
            row[idx["wind_mw"]] = -wind_peak_per_mw
        elif has_individual_wind:
            for g in wind_gens:
                key = _generator_capacity_key(g)
                if key in idx:
                    row[idx[key]] = -gen_peak_per_mw.get(key, 0.0)
                else:
                    rhs += gen_peak_per_mw.get(key, 0.0) * g.ac_mw
        else:
            rhs += wind_peak_per_mw * cap["wind_mw"]
        if "bess_power_mw" in idx:
            row[idx["bess_power_mw"]] = -1.0
        else:
            rhs += cap["bess_power_mw"]
        if "contracted_capacity_mw" in idx:
            row[idx["contracted_capacity_mw"]] = project.tender.peak_availability_floor
        a_ub.append(row)
        b_ub.append(rhs)

        if "bess_power_mw" in idx and "bess_energy_mwh" in idx:
            row = np.zeros(n, dtype=float)
            # This LP is only a seed for the full hourly dispatch evaluator.
            # Avoid baking in the report's C/4 BESS assumption here; otherwise
            # the bounded search starts from oversized energy and may never test
            # leaner storage that still meets monthly peak availability.
            row[idx["bess_power_mw"]] = 1.0
            row[idx["bess_energy_mwh"]] = -1.0
            a_ub.append(row)
            b_ub.append(0.0)

        res = linprog(
            c=c,
            A_ub=np.vstack(a_ub),
            b_ub=np.asarray(b_ub, dtype=float),
            bounds=list(zip(lower, upper)),
            method="highs",
        )
        if not res.success:
            return None
        return np.asarray(res.x, dtype=float)
    except Exception:
        return None


def evaluate_project(project: ProjectConfig, years: Optional[Sequence[int]] = None,
                     custom_cf: Optional[pd.DataFrame] = None) -> Dict[str, Any]:
    op, first = operating_case(project, years=years, custom_cf=custom_cf, return_first_year_hourly=True)
    tariff, fin, status = required_tariff(project, op)
    return {"project": project, "operating": op, "first_year_dispatch": first, "tariff": tariff, "finance": fin, "status": status}


def optimize_capacity(project: ProjectConfig,
                      bounds: Mapping[str, Tuple[float, float]],
                      years: Sequence[int] = (1, 5, 10, 15, 20, 25),
                      maxiter: int = 10,
                      popsize: int = 8,
                      seed: int = 7,
                      polish: bool = True,
                      custom_cf: Optional[pd.DataFrame] = None,
                      fixed_bess_duration_hours: Optional[float] = None) -> Dict[str, Any]:
    """Optimize portfolio sizing with a deterministic bounded random search.

    ``maxiter`` and ``popsize`` control the number of candidates.  A small HiGHS
    LP provides the first optimized seed, then deterministic bounded search tests
    the nonlinear dispatch/finance objective around it.
    """
    keys = list(bounds.keys())
    lower = np.asarray([bounds[k][0] for k in keys], dtype=float)
    upper = np.asarray([bounds[k][1] for k in keys], dtype=float)
    if np.any(upper < lower):
        raise ValueError("Each optimizer bound must have upper >= lower.")
    bid_multiple_bounds: Optional[Tuple[int, float, float]] = None
    fixed_bess_duration: Optional[float] = None
    fixed_bess_indices: Optional[Tuple[int, int]] = None
    fixed_bess_power_bounds: Optional[Tuple[float, float]] = None
    if "contracted_capacity_mw" in keys:
        cc_idx = keys.index("contracted_capacity_mw")
        mult = float(project.tender.project_mw_multiple or 1.0)
        valid_min = math.ceil((lower[cc_idx] - 1e-9) / mult) * mult
        valid_max = math.floor((upper[cc_idx] + 1e-9) / mult) * mult
        if valid_min > valid_max + 1e-9:
            raise ValueError(
                f"Bid capacity bounds {lower[cc_idx]:g}-{upper[cc_idx]:g} MW do not include a valid "
                f"{mult:g} MW tender multiple."
            )
        bid_multiple_bounds = (cc_idx, valid_min, valid_max)
    if fixed_bess_duration_hours is not None:
        fixed_bess_duration = float(fixed_bess_duration_hours)
        if not np.isfinite(fixed_bess_duration) or fixed_bess_duration <= 0:
            raise ValueError("Fixed BESS duration must be a positive number of hours.")
        if "bess_power_mw" in keys and "bess_energy_mwh" in keys:
            bp_idx = keys.index("bess_power_mw")
            be_idx = keys.index("bess_energy_mwh")
            feasible_bp_min = max(float(lower[bp_idx]), float(lower[be_idx]) / fixed_bess_duration)
            feasible_bp_max = min(float(upper[bp_idx]), float(upper[be_idx]) / fixed_bess_duration)
            if feasible_bp_min > feasible_bp_max + 1e-9:
                raise ValueError(
                    f"{fixed_bess_duration:g}-hour BESS constraint is infeasible under selected "
                    f"BESS MW/MWh bounds. Need a BESS power range overlapping "
                    f"{feasible_bp_min:g}-{feasible_bp_max:g} MW."
                )
            fixed_bess_indices = (bp_idx, be_idx)
            fixed_bess_power_bounds = (feasible_bp_min, feasible_bp_max)
        else:
            fixed_bess_duration = None
    dim = len(keys)
    rng = np.random.default_rng(int(seed))
    n_samples = max(8, int(popsize) * dim * max(1, int(maxiter) + 1))

    cap = project_capacity_summary(project)
    current_map = {
        "wind_mw": cap["wind_mw"],
        "solar_ac_mw": cap["solar_ac_mw"],
        "bess_power_mw": cap["bess_power_mw"],
        "bess_energy_mwh": cap["bess_energy_mwh"],
        "contracted_capacity_mw": cap["contracted_capacity_mw"],
    }
    for gen in project.generators:
        current_map[_generator_capacity_key(gen)] = gen.ac_mw
    if project.tender.peak_schedule_mode == "fixed":
        morning_peak_hours = max(1, len(project.tender.fixed_morning_peak_hours))
        evening_peak_hours = max(1, len(project.tender.fixed_evening_peak_hours))
    else:
        # The RfS window is two hours in the morning block and two hours in the
        # evening block, selected by the buyer schedule.
        morning_peak_hours = 2
        evening_peak_hours = 2
    max_split_window_hours = float(max(morning_peak_hours, evening_peak_hours))
    daily_peak_hours = float(morning_peak_hours + evening_peak_hours)
    split_duration_candidates = tuple(sorted({
        max_split_window_hours,
        max_split_window_hours * 1.25,
        max_split_window_hours * 1.5,
        daily_peak_hours,
    }))

    def normalize_vector(x: Sequence[float]) -> np.ndarray:
        arr = np.minimum(np.maximum(np.asarray(x, dtype=float), lower), upper)
        if bid_multiple_bounds is not None:
            i, valid_min, valid_max = bid_multiple_bounds
            mult = float(project.tender.project_mw_multiple or 1.0)
            arr[i] = round(arr[i] / mult) * mult
            arr[i] = min(max(arr[i], valid_min), valid_max)
        if fixed_bess_duration is not None and fixed_bess_indices is not None and fixed_bess_power_bounds is not None:
            bp_idx, be_idx = fixed_bess_indices
            bp_min, bp_max = fixed_bess_power_bounds
            arr[bp_idx] = min(max(float(arr[bp_idx]), bp_min), bp_max)
            arr[be_idx] = arr[bp_idx] * fixed_bess_duration
        return arr

    def make_project_from_vector(x: Sequence[float]) -> ProjectConfig:
        arr = normalize_vector(x)
        kwargs = dict(zip(keys, [float(v) for v in arr]))
        return scale_project(project, **kwargs)

    def score_result(result: Dict[str, Any]) -> float:
        tariff = result["tariff"]
        if not np.isfinite(tariff):
            return 1e4 + float(result.get("status", {}).get("total_penalty_mwh", 1e4)) / 1000.0
        fin = result["finance"]
        capex_penalty = 0.00005 * fin.capex.total_project_cost_cr if fin is not None else 0.0
        op = result.get("operating")
        spill_gwh = float(op["spill_mwh"].sum()) / 1000.0 if isinstance(op, pd.DataFrame) and "spill_mwh" in op else 0.0
        ppa_gwh = float(op["ppa_mwh"].sum()) / 1000.0 if isinstance(op, pd.DataFrame) and "ppa_mwh" in op else 0.0
        merchant_gwh = float(op["merchant_mwh"].sum()) / 1000.0 if isinstance(op, pd.DataFrame) and "merchant_mwh" in op else 0.0
        re_accounted_gwh = max(ppa_gwh + merchant_gwh + spill_gwh, 1e-9)
        spill_share = spill_gwh / re_accounted_gwh
        # Merchant revenue can make heavy overbuild look tariff-accretive even
        # when it creates a poor FDRE bid design. Keep tariff primary, but make
        # avoidable curtailment a real bid-quality penalty rather than a tiny
        # tie-breaker.
        spill_penalty = 0.0010 * spill_gwh + 4.0 * spill_share
        return float(tariff) + capex_penalty + spill_penalty

    # Candidate matrix: current case, corners around current, and random samples.
    candidates: List[np.ndarray] = []
    current = np.asarray([current_map.get(k, (lo + hi) / 2.0) for k, lo, hi in zip(keys, lower, upper)], dtype=float)
    candidates.append(normalize_vector(current))
    candidates.append(normalize_vector((lower + upper) / 2.0))
    highs_seed = _capacity_seed_highs(project, bounds, keys, custom_cf=custom_cf)
    if highs_seed is not None:
        candidates.append(normalize_vector(highs_seed))
        if "bess_power_mw" in keys and "bess_energy_mwh" in keys:
            bp_i = keys.index("bess_power_mw")
            be_i = keys.index("bess_energy_mwh")
            for duration_hours in tuple(sorted({1.0, 1.5, 2.0, 3.0, 4.0, *split_duration_candidates})):
                trial = highs_seed.copy()
                trial[be_i] = trial[bp_i] * duration_hours
                candidates.append(normalize_vector(trial))
    solar_i = keys.index("solar_ac_mw") if "solar_ac_mw" in keys else None
    wind_i = keys.index("wind_mw") if "wind_mw" in keys else None
    bp_i = keys.index("bess_power_mw") if "bess_power_mw" in keys else None
    be_i = keys.index("bess_energy_mwh") if "bess_energy_mwh" in keys else None
    cc_i = keys.index("contracted_capacity_mw") if "contracted_capacity_mw" in keys else None
    mid_duration = split_duration_candidates[len(split_duration_candidates) // 2]
    max_duration = split_duration_candidates[-1]
    if bp_i is not None and be_i is not None:
        for base_vec in (current, (lower + upper) / 2.0):
            cc = float(base_vec[cc_i]) if cc_i is not None else project.tender.contracted_capacity_mw
            for power_fraction, duration_hours in ((0.75, 4.0), (0.90, 3.0), (1.00, 3.0), (1.25, 2.0)):
                trial = np.asarray(base_vec, dtype=float).copy()
                trial[bp_i] = power_fraction * cc
                trial[be_i] = trial[bp_i] * duration_hours
                candidates.append(normalize_vector(trial))
        cc_values = [float(project.tender.contracted_capacity_mw)]
        if cc_i is not None:
            if bid_multiple_bounds is not None:
                _, valid_min, valid_max = bid_multiple_bounds
            else:
                valid_min, valid_max = float(lower[cc_i]), float(upper[cc_i])
            cc_values = sorted({valid_min, (valid_min + valid_max) / 2.0, valid_max})
        # Cost-aware bid-scaled mix grid.  Solar is the cheap energy source and
        # wind mainly buys evening/monsoon peak support, so the grid brackets
        # solar-heavy designs first.  Storage combinations deliberately reach
        # above the 90% peak-power floor (up to 1.25x) with peak-window-scaled
        # durations, because the cheapest feasible designs usually trade a few
        # extra BESS MW/MWh against expensive wind capacity.
        bid_scaled_pairs = (
            (1.0, 0.5),
            (1.0, 1.0),
            (1.5, 0.25),
            (1.5, 0.75),
            (2.0, 0.0),
            (2.0, 0.25),
            (2.0, 0.5),
            (2.0, 1.0),
            (2.5, 0.25),
        )
        storage_combos = ((1.0, mid_duration), (1.10, max_duration), (1.25, max_duration))
        for cc in cc_values:
            peak_target_mw = project.tender.peak_availability_floor * cc
            for solar_mult, wind_mult in bid_scaled_pairs:
                for power_margin, duration_hours in storage_combos:
                    trial = (lower + upper) / 2.0
                    if cc_i is not None:
                        trial[cc_i] = cc
                    if solar_i is not None:
                        trial[solar_i] = min(max(cc * solar_mult, lower[solar_i]), upper[solar_i])
                    if wind_i is not None:
                        trial[wind_i] = min(max(cc * wind_mult, lower[wind_i]), upper[wind_i])
                    trial[bp_i] = min(max(peak_target_mw * power_margin, lower[bp_i]), upper[bp_i])
                    trial[be_i] = min(max(trial[bp_i] * duration_hours, lower[be_i]), upper[be_i])
                    candidates.append(normalize_vector(trial))
            # Compliance repair candidate: renewables and storage pushed to the
            # top of the bounds for this bid size, so a bounded case is only
            # declared infeasible after the strongest design has been tested.
            trial = (lower + upper) / 2.0
            if cc_i is not None:
                trial[cc_i] = cc
            if solar_i is not None:
                trial[solar_i] = upper[solar_i]
            if wind_i is not None:
                trial[wind_i] = upper[wind_i]
            trial[bp_i] = min(max(peak_target_mw * 1.25, lower[bp_i]), upper[bp_i])
            trial[be_i] = min(max(trial[bp_i] * max_duration, lower[be_i]), upper[be_i])
            candidates.append(normalize_vector(trial))
    # Add a few high-storage / low-contracted stress candidates.
    for frac in (0.25, 0.5, 0.75):
        candidates.append(normalize_vector(lower + frac * (upper - lower)))
    # Deterministic random exploration.  This must not depend on the size of
    # the structured grid above (it previously never ran because the grid
    # always exceeded the sample budget), so the search also covers designs
    # between the grid points.
    for _ in range(n_samples):
        candidates.append(normalize_vector(lower + rng.random(dim) * (upper - lower)))

    best_score = float("inf")
    best_result: Optional[Dict[str, Any]] = None
    best_vector: Optional[np.ndarray] = None
    history: List[Dict[str, Any]] = []
    seen: set[Tuple[float, ...]] = set()
    eval_count = 0
    for idx, x in enumerate(candidates):
        key = tuple(round(float(v), 6) for v in x)
        if key in seen:
            continue
        seen.add(key)
        p = make_project_from_vector(x)
        try:
            result = evaluate_project(p, years=years, custom_cf=custom_cf)
            score = score_result(result)
        except Exception as exc:
            result = {"tariff": float("nan"), "status": {"reason": str(exc), "total_penalty_mwh": 1e7}, "project": p}
            score = 1e5
        eval_count += 1
        if score < best_score:
            best_score = score
            best_result = result
            best_vector = x.copy()
        history.append({"candidate": idx + 1, "score": float(score), "best_score": float(best_score), "tariff": float(result.get("tariff", float("nan"))) if isinstance(result, dict) else float("nan")})

    if best_vector is not None:
        # Greedy coordinate descent from the best candidate.  This always runs
        # (previously it was skipped entirely at Fast effort, so a coarse grid
        # candidate was returned unrefined as the "optimum").  Each direction
        # is walked while the score keeps improving, so the refinement can
        # travel far from the grid winner, e.g. shed expensive wind MW one
        # step at a time.
        polish_rounds = 3 if polish else 1
        max_walk_steps = 15
        cc_mult = float(project.tender.project_mw_multiple or 1.0)
        step = (upper - lower) * 0.05
        if cc_i is not None:
            step[cc_i] = max(step[cc_i], cc_mult)
        for round_idx in range(polish_rounds):
            improved = False
            for j in range(dim):
                if fixed_bess_indices is not None and j == fixed_bess_indices[1]:
                    continue
                if upper[j] - lower[j] <= 1e-9 or step[j] <= 1e-9:
                    continue
                for sign in (-1.0, 1.0):
                    for _ in range(max_walk_steps):
                        trial = best_vector.copy()
                        trial[j] = np.clip(trial[j] + sign * step[j], lower[j], upper[j])
                        trial = normalize_vector(trial)
                        key = tuple(round(float(v), 6) for v in trial)
                        if key in seen:
                            break
                        seen.add(key)
                        p = make_project_from_vector(trial)
                        try:
                            result = evaluate_project(p, years=years, custom_cf=custom_cf)
                            score = score_result(result)
                        except Exception as exc:
                            result = {"tariff": float("nan"), "status": {"reason": str(exc), "total_penalty_mwh": 1e7}, "project": p}
                            score = 1e5
                        eval_count += 1
                        history.append({"candidate": len(history) + 1, "score": float(score), "best_score": float(min(best_score, score)), "tariff": float(result.get("tariff", float("nan"))) if isinstance(result, dict) else float("nan"), "polish_round": round_idx + 1})
                        if score < best_score - 1e-9:
                            best_score = score
                            best_result = result
                            best_vector = trial.copy()
                            improved = True
                            continue
                        break
            step *= 0.5
            if cc_i is not None:
                step[cc_i] = max(step[cc_i], cc_mult)
            if not improved:
                break

    if best_result is None or best_vector is None:
        raise RuntimeError("Optimizer did not evaluate any candidate.")
    best_result["optimizer"] = {
        "success": bool(np.isfinite(best_score) and best_score < 1e4),
        "message": "Completed HiGHS-seeded bounded search with greedy coordinate descent",
        "solver": "scipy.optimize.linprog(method='highs') seed + deterministic nonlinear evaluation + greedy coordinate descent",
        "fixed_bess_duration_hours": float(fixed_bess_duration) if fixed_bess_duration is not None else None,
        "fun": float(best_score),
        "nit": int(maxiter),
        "nfev": int(eval_count),
        "bounds": {k: [float(lo), float(hi)] for k, lo, hi in zip(keys, lower, upper)},
        "variables": dict(zip(keys, [float(v) for v in best_vector])),
        "history": history,
    }
    return best_result


# ---------------------------------------------------------------------------
# Export helpers


def full_term_dispatch_tables(project: ProjectConfig,
                              custom_cf: Optional[pd.DataFrame] = None,
                              include_hourly: bool = True) -> Dict[str, pd.DataFrame]:
    """Return dispatch tables for every operating year in the PPA term.

    The annual table contains one row per PPA year.  The monthly table contains
    one row per PPA month.  When ``include_hourly`` is true, the hourly table
    contains ``ppa_years * 8760`` rows and includes both within-year fields
    (month/day/hour) and continuous PPA-term counters.
    """
    annual_rows: List[Dict[str, Any]] = []
    monthly_rows: List[pd.DataFrame] = []
    hourly_rows: List[pd.DataFrame] = []
    ppa_years = int(project.tender.ppa_years)

    for year in range(1, ppa_years + 1):
        result = dispatch_project_year(project, year=year, custom_cf=custom_cf, return_hourly=include_hourly)
        annual_rows.append(dict(result.summary))

        monthly = result.monthly.copy()
        monthly.insert(0, "year", year)
        monthly.insert(1, "ppa_month", (year - 1) * 12 + monthly["month"].astype(int))
        monthly_rows.append(monthly)

        if include_hourly:
            if result.hourly is None:
                continue
            hourly = result.hourly.copy()
            n = len(hourly)
            hourly.insert(0, "year", year)
            hourly.insert(1, "hour_of_ppa", (year - 1) * HOURS_PER_YEAR + np.arange(1, n + 1))
            hourly.insert(2, "day_of_ppa", (year - 1) * DAYS_PER_YEAR + hourly["day"].astype(int))
            hourly.insert(3, "ppa_month", (year - 1) * 12 + hourly["month"].astype(int))
            hourly_rows.append(hourly)

    annual = pd.DataFrame(annual_rows).sort_values("year").reset_index(drop=True)
    if "year" in annual.columns:
        annual["year"] = annual["year"].astype(int)
    monthly_all = pd.concat(monthly_rows, ignore_index=True) if monthly_rows else pd.DataFrame()
    hourly_all = pd.concat(hourly_rows, ignore_index=True) if hourly_rows else pd.DataFrame()
    return {"annual": annual, "monthly": monthly_all, "hourly": hourly_all}



# ---------------------------------------------------------------------------
# Full-PPA dispatch exports


def full_ppa_dispatch(project: ProjectConfig,
                      custom_cf: Optional[pd.DataFrame] = None,
                      include_hourly: bool = True) -> Dict[str, pd.DataFrame]:
    """Return exact dispatch tables for every contract year in the PPA term.

    The Streamlit dashboard normally evaluates representative years and interpolates
    for fast tariff solving.  Download/audit workflows need the exact simulated
    dispatch for each contract year instead.  This helper runs the hourly dispatch
    independently for year 1 through ``project.tender.ppa_years`` and returns:

    * ``yearly``  - one row per contract year with the dispatch KPIs used in finance;
    * ``monthly`` - monthly peak-availability and shortfall details for every year;
    * ``hourly``  - 8760 rows per contract year when ``include_hourly`` is True.

    The model uses a non-leap 8760-hour operating year.  ``hour_of_ppa`` is therefore
    a sequential hour index over the PPA term and is intentionally independent of a
    civil-calendar leap-year convention.
    """
    n_years = int(project.tender.ppa_years)
    if n_years <= 0:
        raise ValueError("PPA years must be a positive integer.")

    yearly_rows: List[Dict[str, float]] = []
    monthly_frames: List[pd.DataFrame] = []
    hourly_frames: List[pd.DataFrame] = []

    for year in range(1, n_years + 1):
        result = dispatch_project_year(project, year=year, custom_cf=custom_cf, return_hourly=include_hourly)
        yearly_rows.append(dict(result.summary))

        monthly = result.monthly.copy()
        monthly.insert(0, "contract_year", year)
        monthly_frames.append(monthly)

        if include_hourly and result.hourly is not None:
            hourly = result.hourly.copy()
            if "ppa_mwh" not in hourly.columns:
                hourly["ppa_mwh"] = hourly.get("ppa_peak_mwh", 0.0) + hourly.get("ppa_nonpeak_mwh", 0.0)
            if "net_bess_mwh" not in hourly.columns:
                hourly["net_bess_mwh"] = hourly.get("bess_discharge_mwh", 0.0) - hourly.get("bess_charge_mwh", 0.0)
            hourly.insert(0, "contract_year", year)
            hourly.insert(1, "hour_of_contract_year", np.arange(1, HOURS_PER_YEAR + 1, dtype=int))
            hourly.insert(2, "hour_of_ppa", (year - 1) * HOURS_PER_YEAR + np.arange(1, HOURS_PER_YEAR + 1, dtype=int))
            hourly_frames.append(hourly)

    exports: Dict[str, pd.DataFrame] = {
        "yearly": pd.DataFrame(yearly_rows).reset_index(drop=True),
        "monthly": pd.concat(monthly_frames, ignore_index=True) if monthly_frames else pd.DataFrame(),
    }
    if include_hourly:
        exports["hourly"] = pd.concat(hourly_frames, ignore_index=True) if hourly_frames else pd.DataFrame()
    return exports

# ---------------------------------------------------------------------------
# Audit helpers


def project_capacity_summary(project: ProjectConfig) -> Dict[str, float]:
    ppa_years = max(1, int(project.tender.ppa_years))
    bess_power_mw = sum(b.power_mw for b in project.bess)
    bess_energy_mwh = sum(b.energy_mwh for b in project.bess)
    bess_usable_by_year = [
        sum(b.usable_for_year(year) for b in project.bess)
        for year in range(1, ppa_years + 1)
    ]
    bess_usable_y1 = bess_usable_by_year[0] if bess_usable_by_year else 0.0
    bess_usable_final = bess_usable_by_year[-1] if bess_usable_by_year else 0.0
    bess_usable_min = min(bess_usable_by_year) if bess_usable_by_year else 0.0
    return {
        "contracted_capacity_mw": project.tender.contracted_capacity_mw,
        "solar_ac_mw": sum(g.ac_mw for g in project.generators if g.technology.lower() == "solar"),
        "solar_dc_mwp": sum(g.dc_mwp for g in project.generators if g.technology.lower() == "solar"),
        "wind_mw": sum(g.ac_mw for g in project.generators if g.technology.lower() == "wind"),
        "bess_power_mw": bess_power_mw,
        "bess_energy_mwh": bess_energy_mwh,
        "bess_usable_poi_mwh_y1": bess_usable_y1,
        "bess_usable_poi_mwh_final": bess_usable_final,
        "bess_usable_poi_mwh_min": bess_usable_min,
        "bess_nameplate_duration_hours": bess_energy_mwh / bess_power_mw if bess_power_mw > 0 else 0.0,
        "bess_usable_duration_hours_y1": bess_usable_y1 / bess_power_mw if bess_power_mw > 0 else 0.0,
        "bess_usable_duration_hours_final": bess_usable_final / bess_power_mw if bess_power_mw > 0 else 0.0,
        "interconnection_limit_mw": sum(n.interconnection_limit_mw for n in project.nodes),
    }


def compliance_checklist(project: ProjectConfig, operating: Optional[pd.DataFrame] = None) -> pd.DataFrame:
    cap = project_capacity_summary(project)
    rows = [
        ("Bid capacity >= 50 MW", cap["contracted_capacity_mw"] >= project.tender.min_project_mw,
         f"{cap['contracted_capacity_mw']:.1f} MW"),
        ("Bid capacity <= 600 MW", cap["contracted_capacity_mw"] <= project.tender.max_bidder_capacity_mw,
         f"{cap['contracted_capacity_mw']:.1f} MW"),
        ("Bid capacity in 10 MW multiple", abs(cap["contracted_capacity_mw"] / project.tender.project_mw_multiple - round(cap["contracted_capacity_mw"] / project.tender.project_mw_multiple)) < 1e-6,
         f"{cap['contracted_capacity_mw']:.1f} MW"),
        ("Declared annual CUF >= 40%", project.tender.declared_annual_cuf >= 0.40,
         f"{project.tender.declared_annual_cuf:.2%}"),
        ("Peak availability floor >= 90%", project.tender.peak_availability_floor >= 0.90,
         f"{project.tender.peak_availability_floor:.2%}"),
        ("ESS charged only from modeled RE", True, "Dispatch rule enforces local RE-only charge"),
    ]
    if operating is not None:
        comp = physical_compliance(project, operating)
        rows.extend([
            ("Monthly peak availability met", comp["peak_ok"], f"min {comp['min_monthly_peak_availability']:.2%}"),
            ("Annual CUF lower-band met", comp["annual_cuf_ok"], f"min {comp['min_annual_cuf']:.2%}"),
            ("Annual CUF upper-band met", comp["annual_cuf_upper_ok"], f"max {comp['max_annual_cuf']:.2%} <= {comp['annual_cuf_ceiling']:.2%}"),
            ("No modeled penalty MWh", comp["total_penalty_mwh"] <= 1e-6, f"{comp['total_penalty_mwh']:,.0f} MWh"),
        ])
    return pd.DataFrame(rows, columns=["check", "pass", "evidence"])


if __name__ == "__main__":
    project = default_fdre2_project()
    op, first = operating_case(project, years=(1, 5, 10, 15, 20, 25), return_first_year_hourly=False)
    tariff, fin, status = required_tariff(project, op)
    print(json.dumps(project_capacity_summary(project), indent=2))
    print(json.dumps(status, indent=2))
    print("required_tariff", tariff)
    if fin:
        print("equity_irr", fin.equity_irr, "min_dscr", fin.min_dscr)
