from __future__ import annotations

import math
import pathlib
import sys
import base64
import io
import json
import queue
import re
import threading
import zipfile
from dataclasses import asdict, is_dataclass
from typing import Any, Mapping, Literal

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import fdre_enterprise_engine as E
import fdre_eya as YA
import fdre_wind_eya as WYA
import fdre_tender_rag as TRAG
import fdre_rtc_lp as RLP

WIND_SAMPLE_PATH = pathlib.Path("/Users/rachitagarwal/Downloads/Wind Generation Bikaner.csv")
DIST_DIR = ROOT / "react_demo" / "dist"
REPORT_ASSET_DIR = ROOT / "web" / "public" / "report_assets"


class EvaluationRequest(BaseModel):
    project: dict[str, Any] | None = None
    years_mode: str = Field(default="fast", pattern="^(fast|exact)$")
    use_wind_profile: bool = True
    wind_p_level: str = Field(default="P50", pattern="^(P50|P75|P90)$")


class OptimizeRequest(EvaluationRequest):
    effort: str = Field(default="fast", pattern="^(fast|balanced)$")
    bounds: dict[str, tuple[float, float]] | None = None
    fixed_bess_duration_hours: float | None = Field(default=None, ge=0.1, le=24.0)


class OptimizerValidationRequest(EvaluationRequest):
    bounds: dict[str, tuple[float, float]] | None = None
    fixed_bess_duration_hours: float | None = Field(default=None, ge=0.1, le=24.0)


class PvsystUploadFile(BaseModel):
    name: str
    content_base64: str


class PvsystUploadRequest(BaseModel):
    files: list[PvsystUploadFile] = Field(default_factory=list, max_length=3)


class TenderUploadFile(BaseModel):
    name: str
    content_base64: str


class TenderUploadRequest(BaseModel):
    file: TenderUploadFile
    parser: Literal["auto", "standard", "docling"] = "auto"


app = FastAPI(title="FDRE React Demo API", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8000", "http://127.0.0.1:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _clean(value: Any) -> Any:
    if is_dataclass(value):
        return _clean(asdict(value))
    if isinstance(value, pd.DataFrame):
        return [_clean(row) for row in value.to_dict(orient="records")]
    if isinstance(value, pd.Series):
        return _clean(value.to_dict())
    if isinstance(value, np.ndarray):
        return _clean(value.tolist())
    if isinstance(value, Mapping):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        f = float(value)
        return None if not math.isfinite(f) else f
    return value


def _years(mode: str, project: E.ProjectConfig) -> tuple[int, ...]:
    return tuple(range(1, project.tender.ppa_years + 1)) if mode == "exact" else (1, 5, 10, 15, 20, 25)


def _project_from_payload(payload: dict[str, Any] | None) -> E.ProjectConfig:
    if payload:
        return E.project_from_dict(payload)
    return E.default_fdre2_project()


def _wind_report() -> dict[str, Any] | None:
    if not WIND_SAMPLE_PATH.exists():
        return None
    return WYA.parse_wind_generation_csv(str(WIND_SAMPLE_PATH))


def _custom_wind_cf(enabled: bool, p_level: str) -> pd.DataFrame | None:
    if not enabled:
        return None
    report = _wind_report()
    if not report:
        return None
    return WYA.wind_generation_custom_cf(report, p_level)


def _capacity_summary(project: E.ProjectConfig) -> dict[str, Any]:
    cap = E.project_capacity_summary(project)
    return _clean(cap)


def _joulewise_report() -> dict[str, Any] | None:
    path = REPORT_ASSET_DIR / "joulewise_hybrid_eya_report_r1.json"
    if not path.exists():
        path = REPORT_ASSET_DIR / "joulewise_hybrid_eya_report.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _finance_summary(fin: E.FinanceResult | None) -> dict[str, Any] | None:
    if fin is None:
        return None
    return _clean({
        "tariff_rs_per_kwh": fin.tariff_rs_per_kwh,
        "equity_irr": fin.equity_irr,
        "project_irr": fin.project_irr,
        "min_dscr": fin.min_dscr,
        "avg_dscr": fin.avg_dscr,
        "npv_equity_cr": fin.npv_equity_cr,
        "total_project_cost_cr": fin.capex.total_project_cost_cr,
        "debt_cr": fin.capex.debt_cr,
        "equity_cr": fin.capex.equity_cr,
        "table": fin.table.head(30),
        "capex_components": fin.capex.components,
    })


def _operating_summary(op: pd.DataFrame) -> dict[str, Any]:
    return _clean({
        "annual": op[[
            "year", "annual_cuf", "min_monthly_peak_availability",
            "ppa_mwh", "annual_ppa_cap_mwh", "annual_cuf_cap_utilization",
            "annual_cuf_upper_headroom_mwh", "total_penalty_mwh", "merchant_mwh", "spill_mwh",
        ]].to_dict(orient="records"),
        "totals": {
            "ppa_gwh": op["ppa_mwh"].sum() / 1000.0,
            "merchant_gwh": op["merchant_mwh"].sum() / 1000.0,
            "spill_gwh": op["spill_mwh"].sum() / 1000.0,
            "penalty_gwh": op["total_penalty_mwh"].sum() / 1000.0,
            "min_peak_availability": op["min_monthly_peak_availability"].min(),
            "min_annual_cuf": op["annual_cuf"].min(),
            "max_annual_cuf": op["annual_cuf"].max(),
            "annual_cuf_floor": op["annual_cuf_floor"].iloc[0] if "annual_cuf_floor" in op else None,
            "annual_cuf_ceiling": op["annual_cuf_ceiling"].iloc[0] if "annual_cuf_ceiling" in op else None,
            "min_cuf_cap_utilization": op["annual_cuf_cap_utilization"].min() if "annual_cuf_cap_utilization" in op else None,
            "max_cuf_cap_utilization": op["annual_cuf_cap_utilization"].max() if "annual_cuf_cap_utilization" in op else None,
            "cuf_upper_headroom_gwh": op["annual_cuf_upper_headroom_mwh"].sum() / 1000.0 if "annual_cuf_upper_headroom_mwh" in op else None,
        },
    })


def _first_year_summary(first: E.DispatchResult | None) -> dict[str, Any]:
    if first is None:
        return {}
    monthly = first.monthly.copy() if first.monthly is not None else pd.DataFrame()
    if not monthly.empty:
        monthly["month_name"] = [E.MONTH_LABELS[int(m) - 1] for m in monthly["month"]]
    hourly = first.hourly.copy() if first.hourly is not None else pd.DataFrame()
    week = hourly.head(24 * 7).copy() if not hourly.empty else pd.DataFrame()
    return _clean({
        "monthly": monthly.to_dict(orient="records"),
        "summary": first.summary,
        "week": week[[
            "month", "day", "hour", "total_re_mw", "ppa_mwh",
            "bess_charge_mwh", "bess_discharge_mwh", "soc_mwh", "spill_mwh",
        ]].to_dict(orient="records") if not week.empty else [],
    })


def _wind_summary() -> dict[str, Any] | None:
    report = _wind_report()
    if not report:
        return None
    return _clean({
        "source": WIND_SAMPLE_PATH.name,
        "rated_power_mw": report["rated_power_mw"],
        "summary": report["summary"],
        "monthly": report["monthly"],
    })


def _pvsyst_report_summary(report: Mapping[str, Any], uncertainty_pct: float = 4.87) -> dict[str, Any]:
    probability = YA.pvsyst_probability_table(report, uncertainty_pct=uncertainty_pct)
    return _clean({
        "source_name": report.get("source_name"),
        "project": report.get("project"),
        "site": report.get("site"),
        "ac_mw": report.get("ac_mw"),
        "dc_mwp": report.get("dc_mwp"),
        "p50_mwh_y1": report.get("p50_mwh_y1"),
        "specific_yield_kwh_per_kwp": report.get("specific_yield_kwh_per_kwp"),
        "pr_pct": report.get("pr_pct"),
        "ghi_kwh_m2": report.get("ghi_kwh_m2"),
        "ambient_temp_c": report.get("ambient_temp_c"),
        "module": report.get("module"),
        "inverter": report.get("inverter"),
        "probability": probability,
        "monthly": report.get("monthly", pd.DataFrame()),
    })


def _extract_tender_text(name: str, payload: bytes) -> str:
    suffix = pathlib.Path(name).suffix.lower()
    if suffix == ".pdf":
        return YA.extract_pvsyst_pdf_text(payload)
    if suffix == ".docx":
        try:
            import docx  # type: ignore
        except Exception as exc:
            raise RuntimeError("DOCX parsing requires python-docx.") from exc
        doc = docx.Document(io.BytesIO(payload))
        return "\n".join(p.text for p in doc.paragraphs)
    return payload.decode("utf-8", errors="replace")


def _near_percent(text: str, keyword_pattern: str, default: float | None = None) -> float | None:
    for match in re.finditer(keyword_pattern, text, flags=re.IGNORECASE | re.DOTALL):
        forward = text[match.start():min(len(text), match.end() + 180)]
        pct = re.search(r"(\d+(?:\.\d+)?)\s*%", forward)
        if pct:
            return float(pct.group(1))
        start = max(0, match.start() - 120)
        window = text[start:match.end()]
        pct = re.search(r"(\d+(?:\.\d+)?)\s*%", window)
        if pct:
            return float(pct.group(1))
    return default


def _yes_no(condition: bool) -> str:
    return "Yes" if condition else "No"


def _first_text_match(text: str, patterns: list[str], default: str) -> str:
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            return re.sub(r"\s+", " ", match.group(0)).strip(" .")
    return default


def _timeline_rows(text: str) -> list[dict[str, str]]:
    timeline_patterns = [
        ("Tender issue / RfS date", [r"(?:RfS|tender).{0,50}(?:date|issued).{0,40}\d{1,2}[./-]\d{1,2}[./-]\d{2,4}"]),
        ("Pre-bid / clarification", [r"(?:pre[- ]bid|clarification).{0,80}\d{1,2}[./-]\d{1,2}[./-]\d{2,4}"]),
        ("Bid submission deadline", [r"(?:bid submission|last date|due date).{0,90}\d{1,2}[./-]\d{1,2}[./-]\d{2,4}"]),
        ("E-reverse auction", [r"(?:e[- ]reverse|reverse auction|e-RA).{0,80}\d{1,2}[./-]\d{1,2}[./-]\d{2,4}"]),
        ("Scheduled commissioning", [r"(?:scheduled commissioning|SCOD|commissioning).{0,90}(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d+\s*months?)"]),
    ]
    rows = []
    for item, patterns in timeline_patterns:
        detail = _first_text_match(text, patterns, "Not parsed from upload")
        rows.append({"Milestone": item, "Parsed detail": detail, "Bid impact": "Track for bid security, land readiness, equipment ordering and tariff validity"})
    return rows


def _parse_tender_assumptions(text: str) -> dict[str, Any]:
    normalized = re.sub(r"\s+", " ", text)
    project = E.default_fdre2_project()
    tender = project.tender
    peak_pct = _near_percent(normalized, r"peak.{0,80}(availability|hour|period)", tender.peak_availability_floor * 100.0)
    declared_cuf = _near_percent(normalized, r"(declared|annual).{0,80}CUF", tender.declared_annual_cuf * 100.0)
    multiple = tender.project_mw_multiple
    multiple_match = re.search(r"(\d+(?:\.\d+)?)\s*MW.{0,80}(multiple|minimum block|bid)", normalized, flags=re.IGNORECASE)
    if multiple_match:
        multiple = float(multiple_match.group(1))
    max_bid = tender.max_bidder_capacity_mw
    max_match = re.search(r"(maximum|max).{0,80}(\d+(?:\.\d+)?)\s*MW", normalized, flags=re.IGNORECASE)
    if max_match:
        max_bid = float(max_match.group(2))
    tender_size = tender.max_bidder_capacity_mw
    supply_match = re.search(r"supply\s+of\s+(\d+(?:\.\d+)?)\s*MW", normalized, flags=re.IGNORECASE)
    if supply_match:
        tender_size = float(supply_match.group(1))
    ppa_years = tender.ppa_years
    ppa_match = re.search(r"(\d+)\s*(?:year|years).{0,40}(?:PPA|power purchase)", normalized, flags=re.IGNORECASE)
    if ppa_match:
        ppa_years = int(ppa_match.group(1))
    location_allowed = (
        "Anywhere in India / ISTS-connected" if re.search(r"anywhere\s+in\s+india|ISTS", normalized, flags=re.IGNORECASE)
        else "Review uploaded tender for permitted project location"
    )
    storage_required = bool(re.search(r"energy storage|ESS|BESS|storage system", normalized, flags=re.IGNORECASE))
    peak_text = f"{peak_pct:.1f}% monthly peak-period availability" if peak_pct is not None else "Not found"
    cuf_text = f"{declared_cuf:.1f}% declared annual CUF" if declared_cuf is not None else "Not found"
    settings = {
        "declaredCuf": declared_cuf,
        "hardCompliance": True,
        "externalSupport": "external green" in normalized.lower() or "green attributes" in normalized.lower(),
        "tenderProcurementMw": tender_size,
    }
    constraints = [
        {"Constraint": "Monthly peak availability", "Parsed value": f"{peak_pct:.1f}%" if peak_pct is not None else "Not found", "Model field": "peak_availability_floor"},
        {"Constraint": "Declared annual CUF", "Parsed value": f"{declared_cuf:.1f}%" if declared_cuf is not None else "Not found", "Model field": "declared_annual_cuf"},
        {"Constraint": "Bid capacity multiple", "Parsed value": f"{multiple:g} MW", "Model field": "project_mw_multiple"},
        {"Constraint": "Maximum bidder capacity", "Parsed value": f"{max_bid:g} MW", "Model field": "max_bidder_capacity_mw"},
    ]
    overview = [
        {"Item": "Tender size", "Parsed detail": f"{tender_size:g} MW", "Bid impact": "Defines market depth; bidder sets one fixed contracted capacity before technology sizing"},
        {"Item": "Procurement type", "Parsed detail": "Tariff Based Competitive Bidding for FDRE / firm renewable power", "Bid impact": "Optimize for lowest required tariff at target equity IRR while clearing firm supply constraints"},
        {"Item": "Location allowed", "Parsed detail": location_allowed, "Bid impact": "Allows best-resource site selection if ISTS/interconnection and land assumptions are achievable"},
        {"Item": "PPA tenor", "Parsed detail": f"{ppa_years} years", "Bid impact": "Sets finance horizon, degradation exposure, BESS augmentation and debt sculpting period"},
        {"Item": "Energy storage", "Parsed detail": _yes_no(storage_required), "Bid impact": "BESS sizing is required to meet peak availability and manage renewable variability"},
    ]
    technical = [
        {"Aspect": "Peak-period supply", "Parsed detail": peak_text, "Bid strategy implication": "Primary driver for BESS duration and wind/solar diversity"},
        {"Aspect": "Annual CUF floor", "Parsed detail": cuf_text, "Bid strategy implication": "Controls the fixed bid capacity versus annual PPA energy"},
        {"Aspect": "Bid multiple", "Parsed detail": f"{multiple:g} MW", "Bid strategy implication": "Fixed contracted capacity must be entered in valid multiples"},
        {"Aspect": "Maximum bidder capacity", "Parsed detail": f"{max_bid:g} MW", "Bid strategy implication": "Upper limit for bidder portfolio exposure in this tranche"},
        {"Aspect": "External green support", "Parsed detail": _yes_no(settings["externalSupport"]), "Bid strategy implication": "If allowed, penalties may be priced instead of forcing physical overbuild"},
    ]
    commercial = [
        {"Aspect": "Tariff objective", "Model treatment": "Lowest gross tariff that meets target equity IRR, DSCR and selected hard compliance settings", "Bid impact": "Avoids oversizing purely to maximize generation or tariff"},
        {"Aspect": "Debt structure", "Model treatment": "DSCR-sculpted debt with optional DSCR-based debt sizing", "Bid impact": "Prevents late-tenor DSCR from overpricing the bid"},
        {"Aspect": "Capex basis", "Model treatment": "Technology-size-linked capex plus land, transmission/connectivity and owner cost benchmarks", "Bid impact": "Selected MW/MWh directly flow into tariff"},
        {"Aspect": "Curtailment / spill", "Model treatment": "Optimizer penalizes spill after tariff in candidate ranking", "Bid impact": "Discourages oversized renewable build that lowers CUF optics but wastes energy"},
    ]
    return {
        "settings": settings,
        "constraints": constraints,
        "overview": overview,
        "technical": technical,
        "timeline": _timeline_rows(normalized),
        "commercial": commercial,
    }


def _project_tables(project: E.ProjectConfig) -> dict[str, Any]:
    return _clean({
        "nodes": [asdict(n) for n in project.nodes],
        "generators": [asdict(g) for g in project.generators],
        "bess": [asdict(b) for b in project.bess],
        "tender": asdict(project.tender),
        "finance": asdict(project.finance),
        "simulation": asdict(project.simulation),
        "warnings": project.validate(),
    })


def _compliance(project: E.ProjectConfig, op: pd.DataFrame) -> list[dict[str, Any]]:
    checklist = E.compliance_checklist(project, op).copy()
    checklist["status"] = checklist["pass"].map(lambda ok: "Pass" if bool(ok) else "Fail")
    return _clean(checklist.to_dict(orient="records"))


def _eya_summary() -> dict[str, Any]:
    wind = YA.wind_eya()
    solar = YA.solar_eya()
    bess = YA.bess_tables(years=20)
    project = YA.eya_project()
    hybrid = YA.hybrid_eya(project, years=(1, 5, 10, 15, 20), horizon=20)
    summary = YA.hybrid_summary_table(hybrid)
    return _clean({
        "wind": {
            "capacity_mw": wind["capacity_mw"],
            "wtg_model": wind["inputs"]["wtg_model"],
            "wtg_mw": wind["inputs"]["wtg_mw"],
            "n_wtg": wind["inputs"]["n_wtg"],
            "site": wind["inputs"]["site"],
            "hub_m": wind["inputs"]["hub_m"],
            "gross_gwh": wind["gross_gwh"],
            "net_p50_gwh": wind["net_p50_gwh"],
            "sigma_pct": wind["sigma_pct"],
            "plevels": wind["plevels"],
            "uncertainty": wind["inputs"]["uncertainty"],
            "waterfall": [{"stage": stage, "gwh": gwh} for stage, gwh in wind["waterfall"]],
        },
        "solar": [
            {
                "name": site["name"],
                "ac_mw": site["ac_mw"],
                "dc_mwp": site["dc_mwp"],
                "ghi": site["ghi"],
                "temp_c": site["temp_c"],
                "technology": site["technology"],
                "plevels": site["plevels"],
            }
            for site in solar
        ],
        "bess": [
            {
                "name": item["spec"]["name"],
                "power_mw": item["spec"]["power_mw"],
                "poi_mwh": item["spec"]["poi_mwh"],
                "augmentation": item["spec"]["augmentation"],
                "schedule": item["schedule"].head(20),
            }
            for item in bess
        ],
        "hybrid_summary": summary,
        "methodology_note": "Hybrid EYA uses the FDRE hourly dispatch engine at P50/P75/P90 resource levels for screening-grade client review.",
    })


def _response(project: E.ProjectConfig, result: dict[str, Any], wind_enabled: bool, wind_p_level: str) -> dict[str, Any]:
    status = result.get("status", {})
    tariff = result.get("tariff")
    return _clean({
        "project": E.project_to_dict(project),
        "capacity": _capacity_summary(project),
        "tariff": tariff,
        "tariff_label": "Infeasible" if tariff is None or not np.isfinite(float(tariff)) else f"Rs {float(tariff):.2f}/kWh",
        "finance": _finance_summary(result.get("finance")),
        "status": status,
        "operating": _operating_summary(result["operating"]),
        "first_year": _first_year_summary(result.get("first_year_dispatch")),
        "compliance": _compliance(project, result["operating"]),
        "project_tables": _project_tables(project),
        "wind": {
            "enabled": wind_enabled,
            "p_level": wind_p_level,
            "summary": _wind_summary(),
        },
    })


def _result_row(label: str, project: E.ProjectConfig, result: dict[str, Any],
                baseline_tariff: float | None = None, category: str = "") -> dict[str, Any]:
    cap = E.project_capacity_summary(project)
    capex = E.capex_model(project)
    fin = result.get("finance")
    op = result.get("operating")
    status = result.get("status", {})
    tariff = result.get("tariff")
    finite_tariff = float(tariff) if tariff is not None and np.isfinite(float(tariff)) else None
    if isinstance(op, pd.DataFrame) and not op.empty:
        min_peak = float(op["min_monthly_peak_availability"].min())
        min_cuf = float(op["annual_cuf"].min())
        max_cuf = float(op["annual_cuf"].max())
        penalty_gwh = float(op["total_penalty_mwh"].sum() / 1000.0)
        spill_gwh = float(op["spill_mwh"].sum() / 1000.0)
        max_cap_utilization = float(op["annual_cuf_cap_utilization"].max()) if "annual_cuf_cap_utilization" in op else None
    else:
        min_peak = None
        min_cuf = None
        max_cuf = None
        penalty_gwh = None
        spill_gwh = None
        max_cap_utilization = None
    peak_gap = None if min_peak is None else max(0.0, project.tender.peak_availability_floor - min_peak)
    cuf_gap = None if min_cuf is None else max(0.0, project.tender.annual_cuf_floor - min_cuf)
    cuf_upper_excess = None if max_cuf is None else max(0.0, max_cuf - project.tender.annual_cuf_ceiling)
    if peak_gap and peak_gap > 1e-9:
        binding_failure = "Peak availability"
    elif cuf_gap and cuf_gap > 1e-9:
        binding_failure = "Annual CUF lower band"
    elif cuf_upper_excess and cuf_upper_excess > 1e-9:
        binding_failure = "Annual CUF upper band"
    elif finite_tariff is None:
        binding_failure = status.get("reason", "Finance/compliance")
    else:
        binding_failure = "None"
    return _clean({
        "label": label,
        "category": category,
        "feasible": bool(finite_tariff is not None and status.get("reason") == "ok"),
        "tariff_rs_per_kwh": finite_tariff,
        "delta_tariff_rs_per_kwh": None if finite_tariff is None or baseline_tariff is None else finite_tariff - baseline_tariff,
        "solar_mw": cap["solar_ac_mw"],
        "wind_mw": cap["wind_mw"],
        "bess_mw": cap["bess_power_mw"],
        "bess_mwh": cap["bess_energy_mwh"],
        "min_peak_availability": min_peak,
        "annual_cuf": min_cuf,
        "max_annual_cuf": max_cuf,
        "annual_cuf_floor": project.tender.annual_cuf_floor,
        "annual_cuf_ceiling": project.tender.annual_cuf_ceiling,
        "max_cuf_cap_utilization": max_cap_utilization,
        "penalty_gwh": penalty_gwh,
        "spill_gwh": spill_gwh,
        "equity_irr": fin.equity_irr if fin is not None else None,
        "min_dscr": fin.min_dscr if fin is not None else None,
        "project_cost_cr": fin.capex.total_project_cost_cr if fin is not None else capex.total_project_cost_cr,
        "peak_gap_pct_points": None if peak_gap is None else peak_gap * 100.0,
        "cuf_gap_pct_points": None if cuf_gap is None else cuf_gap * 100.0,
        "cuf_upper_excess_pct_points": None if cuf_upper_excess is None else cuf_upper_excess * 100.0,
        "binding_failure": binding_failure,
        "reason": status.get("reason", "unknown"),
    })


def _bounds_hit_rows(cap: Mapping[str, Any], bounds: Mapping[str, tuple[float, float]] | None) -> list[dict[str, Any]]:
    rows = []
    key_map = [
        ("solar_ac_mw", "Solar AC MW", "solar_ac_mw"),
        ("wind_mw", "Wind MW", "wind_mw"),
        ("bess_power_mw", "BESS MW", "bess_power_mw"),
        ("bess_energy_mwh", "BESS MWh", "bess_energy_mwh"),
        ("contracted_capacity_mw", "Contracted MW", "contracted_capacity_mw"),
    ]
    for bound_key, label, cap_key in key_map:
        value = float(cap.get(cap_key, 0.0))
        if bounds and bound_key in bounds:
            lower, upper = [float(v) for v in bounds[bound_key]]
        else:
            lower, upper = value, value
        span = max(upper - lower, 1.0)
        tol = max(0.01, span * 0.005)
        hit_min = value <= lower + tol
        hit_max = value >= upper - tol
        if hit_min and hit_max:
            status = "Fixed"
        elif hit_min:
            status = "At minimum"
        elif hit_max:
            status = "At maximum"
        else:
            status = "Inside"
        rows.append({
            "Variable": label,
            "Selected": value,
            "Minimum": lower,
            "Maximum": upper,
            "Status": status,
            "Interpretation": "Expand this bound and re-run if the selected design is constrained here." if status in {"At minimum", "At maximum"} else "No bound pressure detected.",
        })
    return rows


def _confidence_score(winner: dict[str, Any], exact: dict[str, Any], bounds_rows: list[dict[str, Any]],
                      feasible_alternatives: list[dict[str, Any]], baseline_tariff: float | None) -> dict[str, Any]:
    better = [
        row for row in feasible_alternatives
        if baseline_tariff is not None
        and row.get("tariff_rs_per_kwh") is not None
        and float(row["tariff_rs_per_kwh"]) < baseline_tariff - 0.01
    ]
    active_bound_hits = [
        row for row in bounds_rows
        if row["Variable"] != "Contracted MW" and row["Status"] in {"At minimum", "At maximum"}
    ]
    exact_ok = bool(exact.get("feasible"))
    peak = exact.get("min_peak_availability")
    peak_buffer = None if peak is None else float(peak) - 0.90
    spill_gwh = exact.get("spill_gwh") or 0.0
    if better or not exact_ok:
        score = "Weak"
        rationale = "A cheaper nearby feasible case was found, or the full 25-year confirmation does not pass."
    elif active_bound_hits or (peak_buffer is not None and peak_buffer < 0.005) or spill_gwh > 1000:
        score = "Moderate"
        rationale = "No cheaper nearby feasible case was found, but bound pressure, thin peak margin or high spill needs review."
    else:
        score = "Strong"
        rationale = "No cheaper nearby feasible case was found, bounds are not binding and the exact PPA confirmation passes with margin."
    return {
        "score": score,
        "rationale": rationale,
        "cheaper_feasible_found": bool(better),
        "cheaper_feasible_count": len(better),
        "active_bound_hits": len(active_bound_hits),
        "peak_buffer_pct_points": None if peak_buffer is None else peak_buffer * 100.0,
    }


@app.get("/api/defaults")
def defaults() -> dict[str, Any]:
    project = E.default_fdre2_project()
    return _clean({
        "project": E.project_to_dict(project),
        "capacity": _capacity_summary(project),
        "wind": _wind_summary(),
        "project_tables": _project_tables(project),
        "eya": _eya_summary(),
        "joulewise_report": _joulewise_report(),
    })


@app.get("/api/eya")
def eya() -> dict[str, Any]:
    return _eya_summary()


@app.post("/api/evaluate")
def evaluate(req: EvaluationRequest) -> dict[str, Any]:
    try:
        project = _project_from_payload(req.project)
        custom_cf = _custom_wind_cf(req.use_wind_profile, req.wind_p_level)
        result = E.evaluate_project(project, years=_years(req.years_mode, project), custom_cf=custom_cf)
        return _response(project, result, req.use_wind_profile and custom_cf is not None, req.wind_p_level)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/optimize")
def optimize(req: OptimizeRequest) -> dict[str, Any]:
    try:
        project = _project_from_payload(req.project)
        cap = E.project_capacity_summary(project)
        bounds = req.bounds or {
            "wind_mw": (max(0.0, cap["wind_mw"] * 0.5), max(10.0, cap["wind_mw"] * 2.0)),
            "solar_ac_mw": (max(0.0, cap["solar_ac_mw"] * 0.75), min(800.0, cap["solar_ac_mw"] * 1.5)),
            "bess_power_mw": (0.0, min(500.0, max(cap["bess_power_mw"] * 1.5, project.tender.contracted_capacity_mw * 1.25))),
            "bess_energy_mwh": (0.0, min(2000.0, max(cap["bess_energy_mwh"] * 1.5, project.tender.contracted_capacity_mw * 5.0))),
            "contracted_capacity_mw": (
                max(50.0, project.tender.contracted_capacity_mw - 50.0),
                min(600.0, project.tender.contracted_capacity_mw + 50.0),
            ),
        }
        custom_cf = _custom_wind_cf(req.use_wind_profile, req.wind_p_level)
        maxiter, popsize = (0, 1) if req.effort == "fast" else (1, 1)
        project.simulation.circular_soc_iterations = 1
        result = E.optimize_capacity(
            project,
            bounds,
            years=_years(req.years_mode, project),
            maxiter=maxiter,
            popsize=popsize,
            seed=project.simulation.seed,
            polish=req.effort != "fast",
            custom_cf=custom_cf,
            fixed_bess_duration_hours=req.fixed_bess_duration_hours,
        )
        optimized_project = result["project"]
        return _clean({
            **_response(optimized_project, result, req.use_wind_profile and custom_cf is not None, req.wind_p_level),
            "optimizer": result.get("optimizer", {}),
        })
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/optimizer/validate")
def validate_optimizer(req: OptimizerValidationRequest) -> dict[str, Any]:
    try:
        project = _project_from_payload(req.project)
        project.simulation.circular_soc_iterations = 1
        custom_cf = _custom_wind_cf(req.use_wind_profile, req.wind_p_level)
        fast_years = _years("fast", project)
        cap = E.project_capacity_summary(project)
        bounds = req.bounds or {
            "solar_ac_mw": (cap["solar_ac_mw"], cap["solar_ac_mw"]),
            "wind_mw": (cap["wind_mw"], cap["wind_mw"]),
            "bess_power_mw": (cap["bess_power_mw"], cap["bess_power_mw"]),
            "bess_energy_mwh": (cap["bess_energy_mwh"], cap["bess_energy_mwh"]),
            "contracted_capacity_mw": (cap["contracted_capacity_mw"], cap["contracted_capacity_mw"]),
        }

        winner_result = E.evaluate_project(project, years=fast_years, custom_cf=custom_cf)
        winner_tariff = winner_result.get("tariff")
        baseline_tariff = float(winner_tariff) if winner_tariff is not None and np.isfinite(float(winner_tariff)) else None
        winner = _result_row("Optimizer winner", project, winner_result, baseline_tariff, "winner")

        exact_result = E.evaluate_project(
            project,
            years=tuple(range(1, project.tender.ppa_years + 1)),
            custom_cf=custom_cf,
        )
        exact = _result_row("Full 25-year confirmation", project, exact_result, baseline_tariff, "exact")

        def clamp(name: str, value: float) -> float:
            lo, hi = bounds.get(name, (value, value))
            return min(max(float(value), float(lo)), float(hi))

        def make_candidate(label: str, category: str, **updates: float) -> dict[str, Any]:
            candidate = E.scale_project(
                project,
                solar_ac_mw=updates.get("solar_ac_mw", cap["solar_ac_mw"]),
                wind_mw=updates.get("wind_mw", cap["wind_mw"]),
                bess_power_mw=updates.get("bess_power_mw", cap["bess_power_mw"]),
                bess_energy_mwh=updates.get("bess_energy_mwh", cap["bess_energy_mwh"]),
                contracted_capacity_mw=cap["contracted_capacity_mw"],
            )
            result = E.evaluate_project(candidate, years=fast_years, custom_cf=custom_cf)
            return _result_row(label, candidate, result, baseline_tariff, category)

        candidates: dict[tuple[float, float, float, float], dict[str, Any]] = {}

        def add_candidate(label: str, category: str, solar: float, wind: float, bess_power: float, bess_energy: float) -> None:
            solar = clamp("solar_ac_mw", solar)
            wind = clamp("wind_mw", wind)
            bess_power = clamp("bess_power_mw", bess_power)
            if req.fixed_bess_duration_hours is not None:
                bess_energy = bess_power * float(req.fixed_bess_duration_hours)
            bess_energy = clamp("bess_energy_mwh", bess_energy)
            key = (round(solar, 6), round(wind, 6), round(bess_power, 6), round(bess_energy, 6))
            if key not in candidates:
                candidates[key] = make_candidate(
                    label,
                    category,
                    solar_ac_mw=solar,
                    wind_mw=wind,
                    bess_power_mw=bess_power,
                    bess_energy_mwh=bess_energy,
                )

        local_rows = []
        perturb_specs = [
            ("solar_ac_mw", "Solar"),
            ("wind_mw", "Wind"),
            ("bess_power_mw", "BESS MW"),
            ("bess_energy_mwh", "BESS MWh"),
        ]
        base_values = {
            "solar_ac_mw": cap["solar_ac_mw"],
            "wind_mw": cap["wind_mw"],
            "bess_power_mw": cap["bess_power_mw"],
            "bess_energy_mwh": cap["bess_energy_mwh"],
        }
        for key, label in perturb_specs:
            for pct in (-0.10, -0.05, 0.05, 0.10):
                values = dict(base_values)
                values[key] = base_values[key] * (1.0 + pct)
                row_label = f"{label} {pct:+.0%}"
                add_candidate(row_label, "local perturbation", values["solar_ac_mw"], values["wind_mw"], values["bess_power_mw"], values["bess_energy_mwh"])
                row_key = (
                    round(clamp("solar_ac_mw", values["solar_ac_mw"]), 6),
                    round(clamp("wind_mw", values["wind_mw"]), 6),
                    round(clamp("bess_power_mw", values["bess_power_mw"]), 6),
                    round(clamp("bess_energy_mwh", values["bess_energy_mwh"]), 6),
                )
                local_rows.append(candidates[row_key])

        heatmap_rows = []
        for solar_factor in (0.90, 0.95, 1.00, 1.05, 1.10):
            for bess_energy_factor in (0.90, 0.95, 1.00, 1.05, 1.10):
                label = f"Solar {solar_factor:.0%} / BESS MWh {bess_energy_factor:.0%}"
                add_candidate(
                    label,
                    "solar-bess heatmap",
                    cap["solar_ac_mw"] * solar_factor,
                    cap["wind_mw"],
                    cap["bess_power_mw"],
                    cap["bess_energy_mwh"] * bess_energy_factor,
                )
                key = (
                    round(clamp("solar_ac_mw", cap["solar_ac_mw"] * solar_factor), 6),
                    round(clamp("wind_mw", cap["wind_mw"]), 6),
                    round(clamp("bess_power_mw", cap["bess_power_mw"]), 6),
                    round(clamp("bess_energy_mwh", cap["bess_energy_mwh"] * bess_energy_factor), 6),
                )
                row = dict(candidates[key])
                row["solar_factor"] = solar_factor
                row["bess_energy_factor"] = bess_energy_factor
                heatmap_rows.append(row)

        for wind_factor in (0.90, 1.00, 1.10):
            for bess_power_factor in (0.90, 1.00, 1.10):
                label = f"Wind {wind_factor:.0%} / BESS MW {bess_power_factor:.0%}"
                add_candidate(
                    label,
                    "wind-bess cross-check",
                    cap["solar_ac_mw"],
                    cap["wind_mw"] * wind_factor,
                    cap["bess_power_mw"] * bess_power_factor,
                    cap["bess_energy_mwh"],
                )

        all_rows = list(candidates.values())
        feasible = sorted(
            [row for row in all_rows if row.get("feasible")],
            key=lambda row: float(row.get("tariff_rs_per_kwh") or 1e9),
        )
        infeasible_rows = [row for row in all_rows if not row.get("feasible")]
        def near_miss_score(row: Mapping[str, Any]) -> float:
            peak_gap = float(row.get("peak_gap_pct_points") or 0.0)
            cuf_gap = float(row.get("cuf_gap_pct_points") or 0.0)
            penalty = float(row.get("penalty_gwh") or 0.0)
            return peak_gap * 100.0 + cuf_gap * 100.0 + penalty * 0.01
        infeasible = sorted(infeasible_rows, key=near_miss_score)
        winner_cost = float(winner.get("project_cost_cr") or 0.0)
        cheaper_failed = sorted(
            [row for row in infeasible_rows if winner_cost > 0 and float(row.get("project_cost_cr") or 1e12) < winner_cost],
            key=lambda row: (near_miss_score(row), float(row.get("project_cost_cr") or 1e12)),
        )
        near_miss_summary = {
            "infeasible_count": len(infeasible_rows),
            "closest_case": infeasible[0]["label"] if infeasible else "None",
            "closest_failure": infeasible[0]["binding_failure"] if infeasible else "None",
            "closest_peak_gap_pct_points": infeasible[0].get("peak_gap_pct_points") if infeasible else None,
            "closest_cuf_gap_pct_points": infeasible[0].get("cuf_gap_pct_points") if infeasible else None,
            "lower_cost_failed_count": len(cheaper_failed),
            "lowest_cost_failed_case": min(infeasible_rows, key=lambda row: float(row.get("project_cost_cr") or 1e12))["label"] if infeasible_rows else "None",
        }
        bounds_rows = _bounds_hit_rows(cap, bounds)
        confidence = _confidence_score(winner, exact, bounds_rows, feasible, baseline_tariff)
        validation_checks = [
            {"Check": "Winner summary", "Output": "Selected solar, wind, BESS and tariff captured from optimized project"},
            {"Check": "Bounds hit test", "Output": "Reports variables at min/max search bounds"},
            {"Check": "Local perturbation matrix", "Output": "+/-5% and +/-10% one-variable re-runs"},
            {"Check": "Grid search heatmap", "Output": "Nearby solar vs BESS-energy alternatives"},
            {"Check": "Full 25-year confirmation", "Output": "Exact PPA dispatch and finance re-run for winner"},
            {"Check": "Top 10 feasible alternatives", "Output": "Nearby feasible cases sorted by tariff"},
            {"Check": "Top infeasible near-misses", "Output": "Lowest-penalty failing alternatives and failure reason"},
            {"Check": "Confidence score", "Output": f"{confidence['score']} - {confidence['rationale']}"},
        ]

        return _clean({
            "winner": winner,
            "bounds_hit": bounds_rows,
            "local_perturbations": local_rows,
            "heatmap": heatmap_rows,
            "full_25_year": exact,
            "top_feasible": feasible[:10],
            "near_misses": infeasible[:10],
            "cheap_near_misses": cheaper_failed[:10],
            "near_miss_summary": near_miss_summary,
            "confidence": confidence,
            "validation_checks": validation_checks,
            "evaluated_candidates": len(all_rows),
            "methodology": "Fast validation samples nearby candidate portfolios across representative years, then confirms the optimizer winner on the full 25-year PPA term.",
        })
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/pvsyst/parse")
def parse_pvsyst(req: PvsystUploadRequest) -> dict[str, Any]:
    if not req.files:
        raise HTTPException(status_code=400, detail="Upload at least one PVsyst PDF.")
    parsed = []
    errors = []
    for item in req.files[:3]:
        try:
            payload = base64.b64decode(item.content_base64)
            report = YA.parse_pvsyst_pdf_bytes(payload, source_name=item.name)
            parsed.append(_pvsyst_report_summary(report))
        except Exception as exc:
            errors.append({"name": item.name, "error": str(exc)})
    if not parsed and errors:
        raise HTTPException(status_code=400, detail=errors)
    return {"reports": parsed, "errors": errors}


@app.post("/api/tender/parse")
def parse_tender(req: TenderUploadRequest) -> dict[str, Any]:
    try:
        payload = base64.b64decode(req.file.content_base64)
        parsed = TRAG.parse_tender_document(req.file.name, payload, defaults=E.default_fdre2_project(), parser=req.parser)
        return {
            "document_id": parsed["document_id"],
            "source_pages": parsed["source_pages"],
            "review_fields": parsed["review_fields"],
            "compatibility": parsed["compatibility"],
            "cfd_terms": parsed.get("cfd_terms", []),
            "source_name": parsed["source_name"],
            "tender_schema": parsed["tender_schema"],
            "security": parsed["security"],
            "eligibility": parsed["eligibility"],
            "risk_flags": parsed["risk_flags"],
            "settings": parsed["settings"],
            "constraints": parsed["constraints"],
            "overview": parsed["overview"],
            "technical": parsed["technical"],
            "timeline": parsed["timeline"],
            "commercial": parsed["commercial"],
            "financial": parsed["financial"],
            "amendments": parsed["amendments"],
            "rag_sources": parsed["rag_sources"],
            "rag_status": parsed["rag_status"],
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/export/full-dispatch")
def export_full_dispatch(req: EvaluationRequest) -> Response:
    try:
        project = _project_from_payload(req.project)
        custom_cf = _custom_wind_cf(req.use_wind_profile, req.wind_p_level)
        tables = E.full_ppa_dispatch(project, custom_cf=custom_cf, include_hourly=True)
        capacity = E.project_capacity_summary(project)
        metadata = {
            "scope": "Full 25-year hourly FDRE dispatch export",
            "ppa_years": project.tender.ppa_years,
            "hours_per_year": E.HOURS_PER_YEAR,
            "total_hours": int(project.tender.ppa_years * E.HOURS_PER_YEAR),
            "wind_profile": req.wind_p_level if req.use_wind_profile and custom_cf is not None else "project/default",
            "capacity": _clean(capacity),
            "files": {
                "dispatch_hourly_25yr.csv": "One row per modeled operating hour across the PPA term.",
                "dispatch_monthly_25yr.csv": "Monthly compliance and energy summary for each contract year.",
                "dispatch_yearly_25yr.csv": "Annual dispatch KPIs used for long-term compliance review.",
                "project_config.json": "Project configuration used for the export.",
            },
        }
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("dispatch_hourly_25yr.csv", tables["hourly"].to_csv(index=False))
            zf.writestr("dispatch_monthly_25yr.csv", tables["monthly"].to_csv(index=False))
            zf.writestr("dispatch_yearly_25yr.csv", tables["yearly"].to_csv(index=False))
            zf.writestr("project_config.json", json.dumps(_clean(asdict(project)), indent=2))
            zf.writestr("README.json", json.dumps(metadata, indent=2))
        filename = "fdre_full_25yr_dispatch.zip"
        return Response(
            content=buffer.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


if DIST_DIR.exists():
    app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")

if REPORT_ASSET_DIR.exists():
    app.mount("/report_assets", StaticFiles(directory=REPORT_ASSET_DIR), name="report_assets")


# at most two HiGHS sizing runs at a time per engine process (about 250 MB each while solving)
_RTC_LP_SLOTS = threading.Semaphore(2)


@app.post("/api/rtc/lp")
async def rtc_lp(request: Request) -> StreamingResponse:
    """Round-the-clock sizing LP (HiGHS). Streams NDJSON: log lines, progress, then the result."""
    try:
        payload = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Body must be JSON") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object")
    events: queue.Queue = queue.Queue()

    def work() -> None:
        try:
            if not _RTC_LP_SLOTS.acquire(blocking=False):
                events.put({"type": "log", "t": 0, "stage": "highs", "msg": "Another HiGHS run is in progress on this server; waiting for a free slot"})
                _RTC_LP_SLOTS.acquire()
            try:
                result = RLP.solve(
                    payload,
                    on_log=lambda line: events.put({"type": "log", **line}),
                    on_progress=lambda p: events.put({"type": "progress", **p}),
                )
            finally:
                _RTC_LP_SLOTS.release()
            result.pop("log", None)  # already streamed line by line
            events.put({"type": "result", "result": result})
        except RLP.LpInputError as exc:
            events.put({"type": "error", "error": str(exc)})
        except Exception as exc:  # report solver failures to the browser instead of a dropped stream
            events.put({"type": "error", "error": f"HiGHS run failed: {exc}"})
        finally:
            events.put(None)

    threading.Thread(target=work, daemon=True).start()

    def finite(value: Any) -> Any:  # JSON has no Infinity/NaN: send null instead
        if isinstance(value, float):
            return value if math.isfinite(value) else None
        if isinstance(value, dict):
            return {k: finite(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [finite(v) for v in value]
        return value

    def stream():
        while True:
            item = events.get()
            if item is None:
                break
            yield json.dumps(finite(item), default=float) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson",
                             headers={"cache-control": "no-cache, no-transform", "x-accel-buffering": "no"})


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str = ""):
    index = DIST_DIR / "index.html"
    if index.exists():
        return FileResponse(index)
    return {"message": "Run npm install && npm run dev in react_demo, or npm run build to serve the bundled frontend."}
