"""Energy Yield Assessment (EYA) module for the FDRE Optimizer.

Produces an online version of a consultant-style Hybrid EYA report
(wind EYA, solar EYA per site, BESS schedules, hybrid P50/P75/P90
assessment and 20-year annexure), following the structure of the
RE4Climate "Hybrid EYA Report - 250 MW NHPC FDRE" for the Bikaner /
Jaisalmer portfolio. Defaults are calibrated to that report.

The hybrid assessment reuses the engine's hourly dispatch
(fdre_enterprise_engine) at P-level-scaled resource, rather than the
consultant's LP - definitions of supply/surplus/curtailment follow the
report. Component-level generation reproduces the report by construction
(net CUFs are taken from the report's P50 results).
"""
from __future__ import annotations

import copy
import hashlib
import io
import math
import os
import re
import subprocess
import sys
from typing import Dict, List, Mapping, Optional, Sequence

import numpy as np
import pandas as pd

import fdre_enterprise_engine as E

Z_LEVELS = {"P50": 0.0, "P75": -0.67449, "P90": -1.28155, "P99": -2.32635}
MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December"]
MONTH_PATTERN = "|".join(MONTH_NAMES + ["Year"])

# ---------------------------------------------------------------------------
# Report-calibrated defaults (RE4C Hybrid EYA, 250 MW NHPC FDRE)

WIND_DEFAULTS = dict(
    site="Lakha Wind Farm, Village Likdi, Tehsil Shiv, District Jaisalmer & Barmer, Rajasthan",
    wtg_model="Suzlon S144_3.15MW", rotor_m=144.0, hub_m=140.0, wtg_mw=3.15, n_wtg=16,
    free_ws=7.34, gross_gwh_before_wake=235.70,
    array_efficiency=0.8430,  # wake
    other_losses={  # multiplicative efficiencies
        "Machine Availability": 0.9750, "BOP Availability": 0.9950,
        "Grid Availability (CTU)": 0.9950, "Transmission Efficiency": 0.9700,
        "Wind farm self-Consumption": 0.9950, "Turbine Performance": 0.9800,
        "Turbine Degradation": 0.9900, "Curtailment": 1.0000,
        "Environmental": 0.9930, "Additional future wake loss": 1.0000,
    },
    uncertainty={  # % on 25-yr AEP, combined by RSS
        "Wind Measurement uncertainty": 2.51, "Data Documentation uncertainty": 1.00,
        "Long Term scaling uncertainty": 2.00, "Wind resource variability": 1.41,
        "Vertical extrapolation uncertainty": 4.00, "Horizontal extrapolation uncertainty": 3.75,
        "Wake modelling": 5.50, "Power Curve uncertainty": 4.00,
    },
)

SOLAR_SITES_DEFAULTS = [
    dict(name="Bikaner II", ac_mw=60.0, dc_mwp=90.0, dc_ac=1.50,
         location="Village Randhisar, Tehsil Kolayat, District Bikaner, Rajasthan",
         lat="28.16 N", lon="72.96 E", altitude_m=178, meteo="SolarGIS - TMY",
         ghi=1958.3, temp_c=27.18, technology="TOPCon Bifacial (Waaree 605/610/615 Wp)",
         inverter="Sungrow 4400 kWac x 14", mounting="Fixed tilt 18 deg, pitch 7.50 m",
         p50_mwh_y1=165349.0, uncertainty_pct=4.87),
    dict(name="Bikaner III", ac_mw=240.0, dc_mwp=360.0, dc_ac=1.50,
         location="Village Barju, District Bikaner, Rajasthan",
         lat="28.38 N", lon="73.16 E", altitude_m=191, meteo="SolarGIS - TMY",
         ghi=1941.0, temp_c=26.67, technology="TOPCon Bifacial (Waaree 605/610/615 Wp)",
         inverter="Sungrow 4400 kWac x 55", mounting="Fixed tilt 18 deg, pitch 7.50 m",
         p50_mwh_y1=653237.0, uncertainty_pct=4.87),
]

BESS_540_SOH = [1.0, 0.9608, 0.9407, 0.9240, 0.9091, 0.8954, 0.8827, 0.8707, 0.8593, 0.8484] * 2
BESS_540_RTE = [0.8777, 0.8764, 0.8758, 0.8754, 0.8751, 0.8748, 0.8746, 0.8743, 0.8741, 0.8739] * 2
BESS_200_SOH = [1.0, 0.9565, 0.9342, 0.9151, 0.8980, 0.8821, 0.8673, 0.8533, 0.8400, 0.8272] * 2
BESS_200_RTE = [0.8668, 0.8668, 0.8612, 0.8612, 0.8612, 0.8612, 0.8557, 0.8557, 0.8557, 0.8557] * 2

BESS_DEFAULTS = [
    dict(name="Bikaner III BESS (540 MWh)", nameplate_mwh=582.929, dc_usable_mwh=566.73,
         poi_mwh=540.0, power_mw=135.0, containers="58 x 10.0505 MWh", c_rate="C/4 (0.25)",
         cycles_per_day=1, dod="100% of usable", augmentation="100% in Year 11",
         soh=BESS_540_SOH, rte=BESS_540_RTE),
    dict(name="Bikaner II BESS (200 MWh)", nameplate_mwh=234.82, dc_usable_mwh=217.94,
         poi_mwh=200.0, power_mw=50.0, containers="40 x 5.032 + 8 x 4.193 MWh", c_rate="C/4 (0.25)",
         cycles_per_day=1, dod="100% of usable", augmentation="100% in Year 11",
         soh=BESS_200_SOH, rte=BESS_200_RTE),
]

HYBRID_DEFAULTS = dict(
    contracted_mw=250.0, declared_cuf=0.40, horizon_years=20,
    peak_window="18:00 - 22:00 (evening, 4 hours)", peak_hours=(18, 19, 20, 21),
    solar_degradation=0.0040, wind_degradation=0.0,
    transmission_loss_pct=0.85,  # indicative 33 kV -> PoI, for the loss line in the report table
    non_participating="Bikaner II merchant plant (100 MW solar + 164 MWh BESS) shares the 100 MW "
                      "Bikaner II connectivity; only participating capacity is assessed for FDRE "
                      "compliance (merchant plant treated as must-run for curtailment context).",
)


# ---------------------------------------------------------------------------
# Component EYAs

def _first_match(text: str, pattern: str, default=None, flags: int = re.IGNORECASE | re.DOTALL):
    m = re.search(pattern, text, flags)
    if not m:
        return default
    return m.group(1).strip()


def _to_float(value, default: Optional[float] = None) -> Optional[float]:
    if value is None:
        return default
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return default


def _extract_pvsyst_text_external(pdf_bytes: bytes) -> str:
    """Best-effort PDF text extraction when the app Python lacks pypdf."""
    script = (
        "import io, sys\n"
        "from pypdf import PdfReader\n"
        "reader = PdfReader(io.BytesIO(sys.stdin.buffer.read()))\n"
        "sys.stdout.write('\\n'.join((page.extract_text() or '') for page in reader.pages))\n"
    )
    candidates = [
        os.environ.get("FDRE_PDF_PYTHON"),
        os.path.expanduser("~/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"),
        sys.executable,
    ]
    seen = set()
    for py in candidates:
        if not py or py in seen or not os.path.exists(py):
            continue
        seen.add(py)
        try:
            proc = subprocess.run([py, "-c", script], input=pdf_bytes, capture_output=True,
                                  timeout=30, check=False)
        except Exception:
            continue
        if proc.returncode == 0 and proc.stdout:
            return proc.stdout.decode("utf-8", errors="replace")
    raise RuntimeError("PDF text extraction needs pypdf. Install pypdf or set FDRE_PDF_PYTHON to a Python that has it.")


def extract_pvsyst_pdf_text(pdf_bytes: bytes) -> str:
    """Extract text from a PVsyst PDF without making pypdf a startup dependency."""
    try:
        from pypdf import PdfReader  # type: ignore
        reader = PdfReader(io.BytesIO(pdf_bytes))
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    except ModuleNotFoundError:
        return _extract_pvsyst_text_external(pdf_bytes)


def parse_pvsyst_text(text: str, source_name: str = "") -> dict:
    """Parse the standard PVsyst simulation report fields used by solar EYA."""
    if "PVsyst" not in text or "Produced Energy" not in text:
        raise ValueError("This does not look like a PVsyst simulation report.")

    project = _first_match(text, r"Project:\s*([^\n]+)", "")
    variant = _first_match(text, r"Variant:\s*([^\n]+)", "")
    site = _first_match(text, r"Geographical Site\s+(.+?)\s+India", "") or _first_match(text, r"\n([^\n]+)\s+-\s+India", "")
    weather = _first_match(text, r"Weather data\s+.+?\s+(Meteonorm[^\n]+|SolarGIS[^\n]+|NASA[^\n]+)", "")
    if not weather:
        weather = _first_match(text, r"Weather data\s+(.+?)\s+System summary", "")

    lat = lon = altitude = None
    geo = re.search(r"Latitude\s+Longitude\s+Altitude\s+Time zone\s+([0-9.+-]+)\s+([0-9.+-]+)\s+([0-9.+-]+)",
                    text, re.IGNORECASE | re.DOTALL)
    if geo:
        lat, lon, altitude = (_to_float(geo.group(1)), _to_float(geo.group(2)), _to_float(geo.group(3)))

    dc_mwp = _to_float(_first_match(text, r"System power:\s*([0-9.]+)\s*MWp"))
    if dc_mwp is None:
        dc_mwp = _to_float(_first_match(text, r"Pnom total\s+\d+\s+([0-9.]+)\s+units\s+MWp"))

    ac_kw = _to_float(_first_match(
        text, r"Total inverter power\s+Total power\s+Number of inverters\s+Pnom ratio\s+([0-9.]+)\s+\d+\s+[0-9.]+\s+kWac"))
    if ac_kw is None:
        ac_kw = _to_float(_first_match(
            text, r"Inverters\s+Nb\. of units\s+Total power\s+Pnom ratio\s+\d+\s+([0-9.]+)\s+[0-9.]+\s+units\s+kWac"))
    if ac_kw is None:
        pnom_ratio = _to_float(_first_match(text, r"Pnom ratio\s+\d+\s+[0-9.]+\s+([0-9.]+)\s+units\s+kWac"))
        ac_kw = dc_mwp * 1000.0 / pnom_ratio if dc_mwp and pnom_ratio else None
    if ac_kw is None:
        ac_candidates = [_to_float(v) for v in re.findall(r"([0-9.]+)\s+kWac", text, re.IGNORECASE)]
        ac_kw = max([v for v in ac_candidates if v is not None], default=None)
    ac_mw = ac_kw / 1000.0 if ac_kw else None

    produced_kwh = _to_float(_first_match(text, r"Produced Energy\s+([0-9,]+)\s+kWh/year"))
    specific_yield = _to_float(_first_match(text, r"Specific production\s+([0-9,]+)\s+kWh/kWp/year"))
    pr_pct = _to_float(_first_match(text, r"Perf\.?\s*Ratio\s+PR\s+Bifacial perf\.?\s*ratio\s+([0-9.]+)"))
    if pr_pct is None:
        pr_pct = _to_float(_first_match(text, r"Specific production\s+[0-9,]+\s+([0-9.]+)\s+[0-9.]+\s+kWh/kWp/year"))
    bifacial_pr_pct = _to_float(_first_match(text, r"Bifacial perf\.?\s*ratio\s+[0-9.]+\s+([0-9.]+)"))

    tilt = azimuth = None
    orient = re.search(r"Tilt/Azimuth\s+([0-9.+-]+)\s*/\s*([0-9.+-]+)", text, re.IGNORECASE)
    if orient:
        tilt, azimuth = _to_float(orient.group(1)), _to_float(orient.group(2))

    module = _first_match(text, r"PV module\s+Manufacturer\s+Model\s+(.+?)\s+Unit Nom\. Power", "")
    module = " ".join(module.split()) if module else ""
    inverter = _first_match(text, r"Inverter\s+Manufacturer\s+Model\s+(.+?)\s+Unit Nom\. Power", "")
    inverter = " ".join(inverter.split()) if inverter else ""

    monthly_rows = []
    monthly_pattern = re.compile(
        rf"^({MONTH_PATTERN})\s+"
        r"([0-9.]+)\s+([0-9.]+)\s+([0-9.+-]+)\s+([0-9.]+)\s+([0-9.]+)\s+"
        r"([0-9,]+)\s+([0-9,]+)\s+([0-9.]+)\s+([0-9.]+)",
        re.MULTILINE,
    )
    for m in monthly_pattern.finditer(text):
        month = m.group(1)
        row = {
            "Month": month,
            "GlobHor (kWh/m2)": _to_float(m.group(2), 0.0),
            "DiffHor (kWh/m2)": _to_float(m.group(3), 0.0),
            "T_Amb (C)": _to_float(m.group(4), 0.0),
            "GlobInc (kWh/m2)": _to_float(m.group(5), 0.0),
            "GlobEff (kWh/m2)": _to_float(m.group(6), 0.0),
            "EArray (kWh)": _to_float(m.group(7), 0.0),
            "E_Grid (kWh)": _to_float(m.group(8), 0.0),
            "PR": _to_float(m.group(9), 0.0),
            "PRBifi": _to_float(m.group(10), 0.0),
        }
        monthly_rows.append(row)

    year_row = next((r for r in monthly_rows if r["Month"] == "Year"), {})
    if produced_kwh is None and year_row:
        produced_kwh = year_row.get("E_Grid (kWh)")
    if specific_yield is None and produced_kwh is not None and dc_mwp:
        specific_yield = produced_kwh / (dc_mwp * 1000.0)

    ac_cuf = produced_kwh / (ac_mw * 1000.0 * 8760.0) if produced_kwh and ac_mw else None
    dc_cuf = produced_kwh / (dc_mwp * 1000.0 * 8760.0) if produced_kwh and dc_mwp else None

    return {
        "source_name": source_name,
        "fingerprint": hashlib.sha1(text.encode("utf-8", errors="ignore")).hexdigest(),
        "project": project,
        "variant": variant,
        "site": site,
        "latitude": lat,
        "longitude": lon,
        "altitude_m": altitude,
        "weather_source": weather,
        "dc_mwp": dc_mwp,
        "ac_mw": ac_mw,
        "dc_ac": dc_mwp / ac_mw if dc_mwp and ac_mw else None,
        "produced_energy_kwh": produced_kwh,
        "p50_mwh_y1": produced_kwh / 1000.0 if produced_kwh else None,
        "specific_yield_kwh_per_kwp": specific_yield,
        "pr_pct": pr_pct,
        "bifacial_pr_pct": bifacial_pr_pct,
        "ghi_kwh_m2": year_row.get("GlobHor (kWh/m2)") if year_row else None,
        "ambient_temp_c": year_row.get("T_Amb (C)") if year_row else None,
        "tilt_deg": tilt,
        "azimuth_deg": azimuth,
        "module": module,
        "inverter": inverter,
        "ac_cuf": ac_cuf,
        "dc_cuf": dc_cuf,
        "monthly": monthly_rows,
        "loss_text": _first_match(text, r"Loss diagram\s+(.+?)\s+Page\s+\d+/\d+", ""),
    }


def parse_pvsyst_pdf_bytes(pdf_bytes: bytes, source_name: str = "") -> dict:
    return parse_pvsyst_text(extract_pvsyst_pdf_text(pdf_bytes), source_name=source_name)


def pvsyst_level_metrics(report: Mapping[str, object], level: str = "P50",
                         uncertainty_pct: float = 4.87) -> dict:
    """Return PVsyst production/CUF metrics at P50/P75/P90-style probability levels."""
    if level not in Z_LEVELS:
        raise ValueError(f"Unsupported probability level: {level}")
    p50_mwh = float(report.get("p50_mwh_y1") or 0.0)
    dc_mwp = float(report.get("dc_mwp") or 0.0)
    ac_mw = float(report.get("ac_mw") or 0.0)
    factor = p_factor(float(uncertainty_pct), level)
    mwh = p50_mwh * factor
    return {
        "level": level,
        "factor": factor,
        "mwh_y1": mwh,
        "specific_yield_kwh_per_kwp": mwh * 1000.0 / (dc_mwp * 1000.0) if dc_mwp else 0.0,
        "dc_cuf": mwh / (dc_mwp * 8760.0) if dc_mwp else 0.0,
        "ac_cuf": mwh / (ac_mw * 8760.0) if ac_mw else 0.0,
    }


def pvsyst_probability_table(report: Mapping[str, object],
                             uncertainty_pct: float = 4.87,
                             levels: Sequence[str] = ("P50", "P75", "P90")) -> pd.DataFrame:
    rows = []
    for level in levels:
        metrics = pvsyst_level_metrics(report, level=level, uncertainty_pct=uncertainty_pct)
        rows.append({
            "P-level": level,
            "Factor": metrics["factor"],
            "Generation Y1 (MWh)": metrics["mwh_y1"],
            "Specific yield (kWh/kWp)": metrics["specific_yield_kwh_per_kwp"],
            "DC CUF %": 100.0 * metrics["dc_cuf"],
            "AC CUF %": 100.0 * metrics["ac_cuf"],
        })
    return pd.DataFrame(rows)


def pvsyst_to_solar_site(report: Mapping[str, object], base: Optional[dict] = None,
                         name: Optional[str] = None, uncertainty_pct: Optional[float] = None,
                         level: str = "P50") -> dict:
    """Convert a parsed PVsyst report into the solar-site schema used by EYA."""
    site = dict(base or {})
    uncertainty = float(uncertainty_pct if uncertainty_pct is not None
                        else site.get("uncertainty_pct", 4.87))
    metrics = pvsyst_level_metrics(report, level=level, uncertainty_pct=uncertainty)
    out_name = name or str(report.get("site") or site.get("name") or "PVsyst Solar")
    lat = report.get("latitude")
    lon = report.get("longitude")
    tilt = report.get("tilt_deg")
    azimuth = report.get("azimuth_deg")
    out = {
        **site,
        "name": out_name,
        "ac_mw": float(report.get("ac_mw") or site.get("ac_mw") or 0.0),
        "dc_mwp": float(report.get("dc_mwp") or site.get("dc_mwp") or 0.0),
        "location": str(report.get("site") or site.get("location") or ""),
        "lat": f"{float(lat):.4f} N" if lat is not None else site.get("lat", ""),
        "lon": f"{float(lon):.4f} E" if lon is not None else site.get("lon", ""),
        "altitude_m": float(report.get("altitude_m") or site.get("altitude_m") or 0.0),
        "meteo": f"PVsyst: {report.get('weather_source') or 'simulation report'}",
        "ghi": float(report.get("ghi_kwh_m2") or site.get("ghi") or 0.0),
        "temp_c": float(report.get("ambient_temp_c") or site.get("temp_c") or 0.0),
        "technology": f"PVsyst module: {report.get('module') or site.get('technology', '')}".strip(),
        "inverter": f"PVsyst inverter: {report.get('inverter') or site.get('inverter', '')}".strip(),
        "mounting": f"PVsyst fixed plane, tilt {tilt or 'NA'} deg, azimuth {azimuth or 'NA'} deg",
        "p50_mwh_y1": float(metrics["mwh_y1"]),
        "uncertainty_pct": uncertainty,
        "pvsyst_source": str(report.get("source_name") or report.get("project") or "PVsyst report"),
        "pvsyst_specific_yield": report.get("specific_yield_kwh_per_kwp"),
        "pvsyst_pr_pct": report.get("pr_pct"),
        "pvsyst_applied_level": level,
        "pvsyst_applied_ac_cuf": metrics["ac_cuf"],
        "pvsyst_applied_dc_cuf": metrics["dc_cuf"],
    }
    out["dc_ac"] = out["dc_mwp"] / out["ac_mw"] if out["ac_mw"] else site.get("dc_ac", 0.0)
    return out


def apply_pvsyst_to_solar_sites(sites: Sequence[dict], report: Mapping[str, object],
                                target_name: str, uncertainty_pct: Optional[float] = None,
                                level: str = "P50") -> List[dict]:
    out = []
    replaced = False
    for site in sites:
        if site.get("name") == target_name:
            out.append(pvsyst_to_solar_site(report, site, name=site.get("name"),
                                            uncertainty_pct=uncertainty_pct, level=level))
            replaced = True
        else:
            out.append(dict(site))
    if not replaced:
        out.append(pvsyst_to_solar_site(report, name=target_name,
                                        uncertainty_pct=uncertainty_pct, level=level))
    return out

def rss(components_pct: Mapping[str, float]) -> float:
    return math.sqrt(sum(v * v for v in components_pct.values()))


def p_factor(sigma_pct: float, level: str) -> float:
    return 1.0 + Z_LEVELS[level] * sigma_pct / 100.0


def wind_eya(w: Optional[dict] = None, levels: Sequence[str] = ("P50", "P75", "P90")) -> dict:
    w = {**WIND_DEFAULTS, **(w or {})}
    capacity = w["wtg_mw"] * w["n_wtg"]
    gross = w["gross_gwh_before_wake"]
    after_wake = gross * w["array_efficiency"]
    other_eff = float(np.prod(list(w["other_losses"].values())))
    net_p50 = after_wake * other_eff
    sigma = rss(w["uncertainty"])
    waterfall = [("Gross generation (before wake)", gross)]
    running = gross
    running *= w["array_efficiency"]
    waterfall.append((f"Wake / array efficiency ({w['array_efficiency']:.2%})", running))
    for name, eff in w["other_losses"].items():
        running *= eff
        waterfall.append((f"{name} ({eff:.2%})", running))
    plevels = {}
    for lv in levels:
        f = p_factor(sigma, lv)
        plevels[lv] = dict(net_gwh=net_p50 * f, plf=net_p50 * f * 1000.0 / (capacity * 8760.0))
    return dict(inputs=w, capacity_mw=capacity, gross_gwh=gross, after_wake_gwh=after_wake,
                total_loss_without_wake=1.0 - other_eff, total_loss_with_wake=1.0 - after_wake / gross * other_eff,
                net_p50_gwh=net_p50, sigma_pct=sigma, waterfall=waterfall, plevels=plevels)


def solar_eya(sites: Optional[List[dict]] = None,
              levels: Sequence[str] = ("P50", "P75", "P90")) -> List[dict]:
    out = []
    for s in (sites or SOLAR_SITES_DEFAULTS):
        res = dict(s)
        res["plevels"] = {}
        for lv in levels:
            f = p_factor(s["uncertainty_pct"], lv)
            mwh = s["p50_mwh_y1"] * f
            res["plevels"][lv] = dict(
                mwh_y1=mwh,
                dc_cuf=mwh / (s["dc_mwp"] * 8760.0),
                ac_cuf=mwh / (s["ac_mw"] * 8760.0),
            )
        out.append(res)
    return out


def bess_tables(bess: Optional[List[dict]] = None, years: int = 20) -> List[dict]:
    out = []
    for b in (bess or BESS_DEFAULTS):
        sched = pd.DataFrame({
            "Year": np.arange(1, years + 1),
            "DC usable (MWh)": [round(b["dc_usable_mwh"] * b["soh"][min(y - 1, len(b["soh"]) - 1)], 2)
                                 for y in range(1, years + 1)],
            "SoH (%)": [round(100 * b["soh"][min(y - 1, len(b["soh"]) - 1)], 2) for y in range(1, years + 1)],
            "RTE (%)": [round(100 * b["rte"][min(y - 1, len(b["rte"]) - 1)], 2) for y in range(1, years + 1)],
        })
        out.append(dict(spec=b, schedule=sched))
    return out


# ---------------------------------------------------------------------------
# EYA project configuration (report-calibrated) for the dispatch engine

def eya_project(wind_res: Optional[dict] = None, solar_res: Optional[List[dict]] = None,
                hy: Optional[dict] = None) -> E.ProjectConfig:
    hy = {**HYBRID_DEFAULTS, **(hy or {})}
    w = wind_eya(wind_res, levels=("P50",))
    sol = solar_eya(solar_res, levels=("P50",))
    nodes = [
        E.NodeSpec("Fatehgarh_4S2", 50.0, state="Rajasthan", gss="Fatehgarh 4S2"),
        E.NodeSpec("Bikaner_III", 150.0, state="Rajasthan", gss="Bikaner III"),
        E.NodeSpec("Bikaner_II", 100.0, state="Rajasthan", gss="Bikaner II"),
    ]
    generators = [
        E.GeneratorSpec(name="Lakha_Wind_S144", technology="wind", node="Fatehgarh_4S2",
                        ac_mw=w["capacity_mw"], dc_mwp=0.0,
                        cuf=w["plevels"]["P50"]["plf"],
                        degradation_per_year=hy["wind_degradation"],
                        capex_cr_per_mw=6.5, opex_lakh_per_mw_year=11.0,
                        notes="16 x S144 3.15 MW @140m; EYA net P50"),
    ]
    for s in sol:
        node = "Bikaner_III" if "III" in s["name"] else "Bikaner_II"
        generators.append(E.GeneratorSpec(
            name=f"{s['name'].replace(' ', '_')}_Solar", technology="solar", node=node,
            ac_mw=s["ac_mw"], dc_mwp=s["dc_mwp"], cuf=s["plevels"]["P50"]["ac_cuf"],
            degradation_per_year=hy["solar_degradation"],
            capex_cr_per_mw=3.1, opex_lakh_per_mw_year=5.5, merchant_price_factor=0.85,
            notes=f"EYA net P50, {s['meteo']}"))
    bess = [
        E.BessSpec(name="Bikaner_III_BESS", node="Bikaner_III", power_mw=135.0,
                   energy_mwh=540.0, usable_mwh_at_poi=540.0, rte=BESS_540_RTE[0],
                   soh_curve=list(BESS_540_SOH), rte_curve=list(BESS_540_RTE),
                   augmentation_years=[11], capex_cr_per_mwh=1.1, pcs_capex_cr_per_mw=0.3,
                   notes="EYA: nameplate 582.9 / DC usable 566.7 / PoI 540 MWh"),
        E.BessSpec(name="Bikaner_II_BESS", node="Bikaner_II", power_mw=50.0,
                   energy_mwh=200.0, usable_mwh_at_poi=200.0, rte=BESS_200_RTE[0],
                   soh_curve=list(BESS_200_SOH), rte_curve=list(BESS_200_RTE),
                   augmentation_years=[11], capex_cr_per_mwh=1.1, pcs_capex_cr_per_mw=0.3,
                   notes="EYA: nameplate 234.8 / DC usable 217.9 / PoI 200 MWh"),
    ]
    ph = list(hy["peak_hours"])
    tender = E.TenderRules(
        contracted_capacity_mw=hy["contracted_mw"], declared_annual_cuf=hy["declared_cuf"],
        peak_schedule_mode="fixed",
        fixed_morning_peak_hours=tuple(ph[:2]), fixed_evening_peak_hours=tuple(ph[2:]),
    )
    proj = E.ProjectConfig("EYA_250MW_NHPC_FDRE", nodes, generators, bess, tender,
                           E.FinanceAssumptions(), E.SimulationAssumptions(seed=42),
                           metadata={"source": "RE4C Hybrid EYA report calibration"})
    return proj


# ---------------------------------------------------------------------------
# Hybrid assessment at P-levels

def _scale_project_plevel(project: E.ProjectConfig, level: str,
                          sigma_wind_pct: float, sigma_solar_pct: float) -> E.ProjectConfig:
    p = copy.deepcopy(project)
    for g in p.generators:
        f = p_factor(sigma_wind_pct if g.technology.lower() == "wind" else sigma_solar_pct, level)
        g.cuf = g.cuf * f
    return p


def hybrid_eya(project: E.ProjectConfig, levels: Sequence[str] = ("P50", "P75", "P90"),
               years: Optional[Sequence[int]] = None, horizon: int = 20,
               sigma_wind_pct: float = 9.47, sigma_solar_pct: float = 4.87,
               trans_loss_pct: float = 0.85) -> Dict[str, dict]:
    """Run the engine's hourly dispatch per P-level and build EYA tables.

    Returns {level: {"yearly": DataFrame, "avg": Series, "monthly_shortage": DataFrame}}.
    """
    if years is None:
        years = [1, 5, 10, 15, 20]
    years = sorted(set(int(y) for y in years) | {1, horizon})
    out: Dict[str, dict] = {}
    gen_names = [(f"gen_{E._safe_name(g.name)}", g.name, g.technology, g.ac_mw)
                 for g in project.generators]
    for lv in levels:
        pj = _scale_project_plevel(project, lv, sigma_wind_pct, sigma_solar_pct)
        rows = []
        monthly_short = np.zeros((len(years), 12))
        for k, y in enumerate(years):
            res = E.dispatch_project_year(pj, year=int(y), return_hourly=True)
            h, s = res.hourly, res.summary
            row = {"Year": int(y)}
            hybrid_net = 0.0
            for col, name, tech, mw in gen_names:
                gwh = float(h[col].sum()) / 1000.0
                row[f"{name} net gen (GWh)"] = gwh
                hybrid_net += gwh
            row["Hybrid net gen (GWh)"] = hybrid_net
            direct_peak = float(h["direct_peak_mwh"].sum()) / 1000.0
            nonpeak = float(h["ppa_nonpeak_mwh"].sum()) / 1000.0
            chg = s["bess_charge_mwh"] / 1000.0
            dis = s["bess_discharge_mwh"] / 1000.0
            row.update({
                "RE simultaneous supply (GWh)": direct_peak + nonpeak,
                "RE supply to ESS (GWh)": chg,
                "RE surplus - merchant (GWh)": s["merchant_mwh"] / 1000.0,
                "RE curtailment (GWh)": s["spill_mwh"] / 1000.0,
                "RE transmission loss (GWh)": hybrid_net * trans_loss_pct / 100.0,
                "ESS supply (GWh)": dis,
                "ESS RTE loss (GWh)": max(0.0, chg - dis),
                "Supply from other sources (GWh)": s["external_green_mwh"] / 1000.0,
                "Energy sold under PPA (GWh)": s["ppa_mwh"] / 1000.0,
                "Shortfall on annual availability (GWh)": s["annual_penalty_mwh"] / 1000.0,
                "Shortfall on monthly availability (GWh)": s["peak_penalty_mwh"] / 1000.0,
                "Annual CUF (%)": 100.0 * s["annual_cuf"],
                "Min monthly peak availability (%)": 100.0 * s["min_monthly_peak_availability"],
                "Total supply peak (GWh)": s["peak_delivered_mwh"] / 1000.0,
                "Simultaneous supply peak (GWh)": direct_peak,
                "ESS supply peak (GWh)": dis,
            })
            for b in pj.bess:
                row[f"{b.name} DC usable BoY (MWh)"] = b.usable_for_year(int(y))
                row[f"{b.name} RTE BoY (%)"] = 100.0 * b.rte_for_year(int(y))
            monthly_short[k, :] = res.monthly["peak_shortfall_mwh"].to_numpy() / 1000.0
            rows.append(row)
        df = pd.DataFrame(rows)
        # interpolate to the full horizon
        full = np.arange(1, horizon + 1)
        interp = {"Year": full}
        for col in df.columns:
            if col == "Year":
                continue
            interp[col] = np.interp(full, df["Year"], df[col])
        yearly = pd.DataFrame(interp)
        avg = yearly.drop(columns=["Year"]).mean()
        ms = pd.DataFrame({
            "Month": MONTH_NAMES,
            "Shortage (GWh, 20-yr avg)": [
                float(np.interp(full, df["Year"], monthly_short[:, m]).mean()) for m in range(12)],
        })
        out[lv] = dict(yearly=yearly, avg=avg, monthly_shortage=ms, sim_years=list(df["Year"]))
    return out


def hybrid_summary_table(results: Dict[str, dict]) -> pd.DataFrame:
    """Report-style '20 Years Average Values' table with one column per P-level."""
    levels = list(results.keys())
    metrics = [c for c in results[levels[0]]["avg"].index]
    data = {"Particulars": metrics}
    for lv in levels:
        data[lv] = [round(float(results[lv]["avg"][m]), 2) for m in metrics]
    return pd.DataFrame(data)


def monthly_shortage_table(results: Dict[str, dict]) -> pd.DataFrame:
    levels = list(results.keys())
    df = pd.DataFrame({"Month": MONTH_NAMES})
    for lv in levels:
        df[lv] = results[lv]["monthly_shortage"]["Shortage (GWh, 20-yr avg)"].round(2)
    return df


# ---------------------------------------------------------------------------
# HTML report export

def build_html_report(wind: dict, solar: List[dict], bess: List[dict],
                      results: Dict[str, dict], hy: dict, project_name: str,
                      client: str = "", consultant_note: str = "") -> str:
    levels = list(results.keys())
    css = """<style>
    body{font-family:Arial,Helvetica,sans-serif;color:#222;margin:36px;font-size:13px}
    h1{background:#1F4E79;color:#fff;padding:10px 14px;font-size:20px}
    h2{color:#1F4E79;border-bottom:2px solid #1F4E79;padding-bottom:4px;font-size:16px;margin-top:28px}
    table{border-collapse:collapse;margin:10px 0;width:100%}
    th{background:#1F4E79;color:#fff;padding:6px 8px;text-align:left;font-size:12px}
    td{border:1px solid #ccc;padding:5px 8px;font-size:12px}
    .note{color:#666;font-style:italic;font-size:11px}
    .num{text-align:right}
    </style>"""

    def tbl(df: pd.DataFrame) -> str:
        return df.to_html(index=False, border=0, classes="", float_format=lambda x: f"{x:,.2f}")

    summary = hybrid_summary_table(results)
    ms = monthly_shortage_table(results)
    wf = pd.DataFrame(wind["waterfall"], columns=["Stage", "Generation (GWh)"])
    unc = pd.DataFrame(list(wind["inputs"]["uncertainty"].items()),
                       columns=["Type of uncertainty", "Uncertainty on AEP (%)"])
    unc.loc[len(unc)] = ["Total (RSS)", round(wind["sigma_pct"], 2)]
    wind_p = pd.DataFrame({
        "Estimation": ["Net generation (GWh)", "Net PLF (%)"],
        **{lv: [round(wind["plevels"][lv]["net_gwh"], 2), round(100 * wind["plevels"][lv]["plf"], 2)]
           for lv in levels if lv in wind["plevels"]},
    })
    solar_rows = []
    for s in solar:
        for lv in levels:
            if lv in s["plevels"]:
                p = s["plevels"][lv]
                solar_rows.append([s["name"], lv, round(p["mwh_y1"], 0),
                                   round(100 * p["dc_cuf"], 2), round(100 * p["ac_cuf"], 2)])
    solar_p = pd.DataFrame(solar_rows, columns=["Site", "P-level", "Generation Y1 (MWh)",
                                                "DC CUF (%)", "AC CUF (%)"])
    html = [f"<html><head><meta charset='utf-8'>{css}</head><body>",
            f"<h1>Hybrid Energy Yield Assessment - {project_name}</h1>",
            f"<p><b>Client:</b> {client or 'N/A'} &nbsp; <b>Assessment horizon:</b> {hy['horizon_years']} years "
            f"&nbsp; <b>Peak window:</b> {hy['peak_window']}</p>",
            f"<p class='note'>{consultant_note or 'Generated by the FDRE Optimizer EYA module. Screening-grade assessment; not a substitute for a bankable independent EYA.'}</p>",
            "<h2>1. Executive summary - hybrid results (average over horizon)</h2>", tbl(summary),
            "<h2>2. Wind EYA</h2>",
            f"<p>{wind['inputs']['site']}<br>{wind['inputs']['wtg_model']}, {wind['inputs']['n_wtg']} WTGs, "
            f"{wind['capacity_mw']:.1f} MW at {wind['inputs']['hub_m']:.0f} m hub height; free wind speed "
            f"{wind['inputs']['free_ws']:.2f} m/s.</p>", tbl(wf), tbl(unc), tbl(wind_p),
            "<h2>3. Solar EYA</h2>"]
    for s in solar:
        html.append(f"<p><b>{s['name']}</b> - {s['ac_mw']:.0f} MWac / {s['dc_mwp']:.0f} MWp (DC:AC {s['dc_ac']}) at "
                    f"{s['location']} ({s['lat']}, {s['lon']}, {s['altitude_m']} m). {s['meteo']}: GHI "
                    f"{s['ghi']:.1f} kWh/m2, ambient {s['temp_c']:.2f} C. {s['technology']}; {s['inverter']}; {s['mounting']}.</p>")
    html.append(tbl(solar_p))
    html.append("<h2>4. Battery energy storage</h2>")
    for b in bess:
        sp = b["spec"]
        html.append(f"<p><b>{sp['name']}</b>: nameplate {sp['nameplate_mwh']:.1f} MWh, DC usable "
                    f"{sp['dc_usable_mwh']:.1f} MWh, PoI {sp['poi_mwh']:.0f} MWh / {sp['power_mw']:.0f} MW; "
                    f"{sp['containers']}; charge/discharge {sp['c_rate']}; {sp['cycles_per_day']} cycle/day; "
                    f"DoD {sp['dod']}; augmentation {sp['augmentation']}.</p>")
        html.append(tbl(b["schedule"]))
    html.append("<h2>5. Methodology</h2>")
    html.append("<p>Hourly chronological dispatch of the hybrid portfolio against the tender's supply "
                "conditions: minimum 90% availability of contracted capacity in the buyer-scheduled peak "
                "window (tested monthly), annual CUF between declared -15% and +10% (PPA offtake capped at "
                "+10%), single tariff for peak and non-peak energy, shortfall penalised at 1.5x tariff. "
                "Generation profiles are P-level-scaled hourly traces (wind sigma from the RSS uncertainty "
                "table; solar sigma per site); solar degrades yearly, wind held at long-term average; ESS "
                "usable capacity and RTE follow the SoH schedules with augmentation in Year 11. BESS charges "
                "from same-node RE only; node evacuation limits are enforced hourly. Surplus is energy "
                "beyond PPA requirements available for merchant sale; curtailment is energy blocked by "
                "evacuation limits or full storage.</p>")
    html.append(f"<p class='note'>{hy['non_participating']}</p>")
    html.append("<h2>6. Monthly shortage (average over horizon)</h2>")
    html.append(tbl(ms))
    for lv in levels:
        html.append(f"<h2>Annexure - yearly results ({lv})</h2>")
        html.append(tbl(results[lv]["yearly"].round(2)))
    html.append("</body></html>")
    return "".join(html)
