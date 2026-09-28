"""Wind Energy Yield Assessment helpers for the FDRE Optimizer app."""
from __future__ import annotations

import importlib.util
import io
import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

Z_LEVELS = {"P50": 0.0, "P75": -0.67449, "P90": -1.28155, "P95": -1.64485}
MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
P_LEVELS = ("P50", "P75", "P90")


@dataclass
class WindAssessmentInputs:
    assessment_name: str = "Wind EYA - Base Case"
    project_version: str = "v1"
    scenario_name: str = "Base"
    engineer: str = ""
    reviewer: str = ""
    approval_status: str = "Draft"
    software_version: str = "FDRE Wind EYA v1"
    methodology: str = "Weibull resource + power curve + sequential loss model"
    mean_wind_speed: float = 7.35
    weibull_a: float = 8.25
    weibull_k: float = 2.05
    turbulence_intensity: float = 0.12
    air_density: float = 1.18
    shear_exponent: float = 0.16
    reference_height_m: float = 120.0
    terrain_complexity: str = "Moderate"
    roughness_class: float = 1.5
    elevation_m: float = 180.0
    slope_deg: float = 2.0
    iec_terrain_category: str = "II"
    manufacturer: str = "Suzlon"
    model: str = "S144"
    rated_power_mw: float = 3.15
    rotor_diameter_m: float = 144.0
    hub_height_m: float = 140.0
    iec_class: str = "S"
    cut_in_speed: float = 3.0
    rated_speed: float = 10.5
    cut_out_speed: float = 25.0
    number_of_turbines: int = 16
    prevailing_alignment_deg: float = 240.0
    wake_groups: str = "Single row / moderate wake"


DEFAULT_LOSSES = {
    "Wake - internal": 7.5,
    "Wake - external": 1.0,
    "Blockage": 0.8,
    "Turbulence": 0.7,
    "Collector system": 1.2,
    "Transformer": 0.6,
    "Substation": 0.4,
    "Auxiliary consumption": 0.5,
    "Scheduled maintenance": 1.0,
    "Forced outages": 1.2,
    "Manufacturer availability": 0.6,
    "Grid availability": 0.5,
    "High temperature": 0.2,
    "Icing": 0.0,
    "Blade soiling": 0.4,
    "Extreme wind shutdown": 0.2,
    "Bird curtailment": 0.1,
    "Noise curtailment": 0.0,
    "Shadow curtailment": 0.0,
    "Grid restrictions": 0.4,
    "Congestion": 0.2,
    "Market curtailment": 0.0,
    "Operator instructions": 0.0,
    "Blade ageing": 0.4,
    "Component degradation": 0.3,
    "Long-term performance": 0.3,
}

DEFAULT_UNCERTAINTIES = {
    "Measurement": 2.5,
    "Long-term correlation": 2.0,
    "Power curve": 4.0,
    "Wake model": 5.5,
    "Terrain": 3.5,
    "Electrical": 1.0,
    "Availability": 1.0,
    "Curtailment": 1.5,
}


def windpowerlib_status() -> dict:
    spec = importlib.util.find_spec("windpowerlib")
    return {
        "available": spec is not None,
        "message": (
            "windpowerlib is installed and can be used for ModelChain/turbine-library simulations."
            if spec is not None
            else "windpowerlib is not installed. Install with: pip install windpowerlib"
        ),
    }


def _parse_percent(value: Any) -> float | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return float(text.rstrip("%")) / (100.0 if text.endswith("%") else 1.0)
    except ValueError:
        return None


def _coerce_hourly_column(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series.astype(str).str.replace(",", "", regex=False), errors="coerce").fillna(0.0)


def parse_wind_generation_csv_bytes(data: bytes,
                                    source_name: str = "Wind generation CSV",
                                    rated_power_mw: float = 3.15) -> dict:
    """Parse the 3.15 MW turbine hourly generation CSV into bankable P-level profiles.

    The file supplied for Bikaner has report metadata/loss rows before the actual
    hourly header. P50/P75/P90 values are hourly turbine generation in kWh, so the
    optimizer-facing capacity factor is kWh / (rated MW * 1000).
    """
    text = data.decode("utf-8-sig", errors="replace")
    lines = text.splitlines()
    header_idx = next(
        (i for i, line in enumerate(lines) if line.strip().lower().startswith("time,local_time,")),
        None,
    )
    if header_idx is None:
        raise ValueError("Could not find hourly header row starting with Time,local_time in wind CSV.")

    metadata: dict[str, Any] = {}
    for raw in lines[:header_idx]:
        parts = [p.strip() for p in raw.split(",")]
        if len(parts) < 2 or not parts[0]:
            continue
        parsed_pct = _parse_percent(parts[1])
        if parsed_pct is not None:
            metadata[parts[0]] = parsed_pct
        numeric_tail = [_parse_percent(p) for p in parts[2:] if p.strip()]
        numeric_tail = [v for v in numeric_tail if v is not None]
        if numeric_tail:
            metadata[f"{parts[0]} value"] = numeric_tail[-1]

    df = pd.read_csv(io.StringIO("\n".join(lines[header_idx:])))
    df.columns = [str(c).strip() for c in df.columns]
    required = {"Time", "P50", "P75", "P90"}
    missing = required.difference(df.columns)
    if missing:
        raise ValueError(f"Wind CSV is missing required columns: {', '.join(sorted(missing))}")

    hourly = pd.DataFrame()
    hourly["Timestamp"] = pd.to_datetime(df["Time"], dayfirst=True, errors="coerce")
    if "local_time" in df.columns:
        hourly["Local time"] = pd.to_datetime(df["local_time"], dayfirst=True, errors="coerce")
    if "wind_speed" in df.columns:
        hourly["Wind Speed (m/s)"] = _coerce_hourly_column(df["wind_speed"])

    rated_power_mw = float(rated_power_mw or 3.15)
    denominator_kwh = max(rated_power_mw * 1000.0, 1e-6)
    summary_rows = []
    for level in P_LEVELS:
        mwh_col = f"{level} MWh/turbine"
        cf_col = f"wind_cf_{level.lower()}"
        kwh = _coerce_hourly_column(df[level])
        hourly[mwh_col] = kwh / 1000.0
        hourly[cf_col] = np.clip(kwh / denominator_kwh, 0.0, 1.25)
        total_mwh = float(hourly[mwh_col].sum())
        summary_rows.append({
            "P-level": level,
            "Per-turbine AEP (MWh)": total_mwh,
            "Per-turbine AEP (GWh)": total_mwh / 1000.0,
            "Capacity factor %": 100.0 * total_mwh / max(rated_power_mw * 8760.0, 1e-6),
        })

    if len(hourly) < 8760:
        raise ValueError("Wind generation CSV must contain at least 8760 hourly rows.")
    hourly = hourly.iloc[:8760].reset_index(drop=True)
    if hourly["Timestamp"].isna().any():
        hourly["Timestamp"] = pd.date_range("2019-01-01", periods=len(hourly), freq="h")

    monthly = hourly.assign(Month=hourly["Timestamp"].dt.month).groupby("Month", as_index=False).agg(
        **{f"{level} MWh/turbine": (f"{level} MWh/turbine", "sum") for level in P_LEVELS}
    )
    monthly["Month"] = [MONTH_NAMES[int(m) - 1] for m in monthly["Month"]]

    return {
        "source_name": source_name,
        "rated_power_mw": rated_power_mw,
        "metadata": metadata,
        "hourly": hourly,
        "monthly": monthly,
        "summary": pd.DataFrame(summary_rows),
    }


def parse_wind_generation_csv(path: str, rated_power_mw: float = 3.15) -> dict:
    with open(path, "rb") as fh:
        return parse_wind_generation_csv_bytes(fh.read(), source_name=path, rated_power_mw=rated_power_mw)


def wind_generation_custom_cf(report: Mapping[str, Any] | None, level: str = "P50") -> pd.DataFrame | None:
    if not report:
        return None
    selected = str(level or "P50").upper()
    if selected not in P_LEVELS:
        raise ValueError(f"Wind profile P-level must be one of {', '.join(P_LEVELS)}.")
    hourly = report.get("hourly")
    if hourly is None:
        return None
    cf_col = f"wind_cf_{selected.lower()}"
    if cf_col not in hourly.columns:
        raise ValueError(f"Wind profile does not include {selected}.")
    return pd.DataFrame({"wind_cf": pd.to_numeric(hourly[cf_col], errors="coerce").fillna(0.0).iloc[:8760].to_numpy()})


def default_layout(n_turbines: int) -> pd.DataFrame:
    cols = int(math.ceil(math.sqrt(n_turbines)))
    spacing_m = 650.0
    rows = []
    for i in range(n_turbines):
        rows.append({
            "Turbine": f"WTG-{i + 1:02d}",
            "X (m)": (i % cols) * spacing_m,
            "Y (m)": (i // cols) * spacing_m,
            "Wake group": f"G{1 + (i // max(1, cols))}",
        })
    return pd.DataFrame(rows)


def default_power_curve(rated_power_mw: float = 3.15,
                        cut_in: float = 3.0,
                        rated_speed: float = 10.5,
                        cut_out: float = 25.0) -> pd.DataFrame:
    speeds = np.arange(0.0, 31.0, 0.5)
    power = power_from_curve(speeds, rated_power_mw, cut_in, rated_speed, cut_out)
    return pd.DataFrame({"Wind speed (m/s)": speeds, "Power (MW)": power})


def power_from_curve(wind_speed: Sequence[float], rated_power_mw: float,
                     cut_in: float, rated_speed: float, cut_out: float) -> np.ndarray:
    ws = np.asarray(wind_speed, dtype=float)
    p = np.zeros_like(ws)
    ramp = (ws >= cut_in) & (ws < rated_speed)
    if rated_speed > cut_in:
        p[ramp] = rated_power_mw * ((ws[ramp] - cut_in) / (rated_speed - cut_in)) ** 3
    p[(ws >= rated_speed) & (ws <= cut_out)] = rated_power_mw
    return p


def interpolate_power(wind_speed: Sequence[float], curve: pd.DataFrame,
                      air_density: float = 1.225) -> np.ndarray:
    clean = curve.dropna().sort_values("Wind speed (m/s)")
    speeds = clean["Wind speed (m/s)"].to_numpy(dtype=float)
    power = clean["Power (MW)"].to_numpy(dtype=float)
    density_factor = max(0.75, min(1.15, air_density / 1.225))
    return np.interp(np.asarray(wind_speed, dtype=float), speeds, power, left=0.0, right=0.0) * density_factor


def weibull_a_from_mean(mean_speed: float, k: float) -> float:
    return float(mean_speed / math.gamma(1.0 + 1.0 / k))


def rss(values: Mapping[str, float]) -> float:
    return float(math.sqrt(sum(float(v) ** 2 for v in values.values())))


def _hourly_index() -> pd.DatetimeIndex:
    return pd.date_range("2026-01-01", periods=8760, freq="h")


def generate_hourly_wind(inputs: WindAssessmentInputs) -> pd.DataFrame:
    idx = _hourly_index()
    hours = np.arange(len(idx), dtype=float)
    hub_mean = inputs.mean_wind_speed * (inputs.hub_height_m / inputs.reference_height_m) ** inputs.shear_exponent
    a_ref = inputs.weibull_a if inputs.weibull_a > 0 else weibull_a_from_mean(inputs.mean_wind_speed, inputs.weibull_k)
    a_hub = a_ref * (inputs.hub_height_m / inputs.reference_height_m) ** inputs.shear_exponent
    # Deterministic quantile series: stable, auditable and shaped by Weibull K/A.
    q = (np.sin(2 * np.pi * hours / 8760.0 - 0.8) + 1.0) / 2.0
    q = 0.04 + 0.92 * ((q + 0.35 * (np.sin(2 * np.pi * hours / 24.0) + 1.0) / 2.0) / 1.35)
    ws = a_hub * (-np.log(1 - np.clip(q, 0.001, 0.999))) ** (1.0 / inputs.weibull_k)
    ws *= hub_mean / max(ws.mean(), 1e-6)
    return pd.DataFrame({"Timestamp": idx, "Wind Speed (m/s)": ws})


def apply_losses(gross_mwh: float, losses: Mapping[str, float]) -> tuple[pd.DataFrame, float]:
    rows = [{"Stage": "Gross AEP", "Loss %": 0.0, "Energy (MWh)": gross_mwh, "Loss MWh": 0.0}]
    running = float(gross_mwh)
    for name, pct in losses.items():
        pct = max(0.0, min(100.0, float(pct)))
        loss = running * pct / 100.0
        running -= loss
        rows.append({"Stage": name, "Loss %": pct, "Energy (MWh)": running, "Loss MWh": loss})
    rows.append({"Stage": "Net AEP", "Loss %": 0.0, "Energy (MWh)": running, "Loss MWh": 0.0})
    return pd.DataFrame(rows), running


def run_wind_eya(inputs: WindAssessmentInputs,
                 losses: Mapping[str, float] | None = None,
                 uncertainties: Mapping[str, float] | None = None,
                 power_curve: pd.DataFrame | None = None,
                 layout: pd.DataFrame | None = None) -> dict:
    losses = dict(losses or DEFAULT_LOSSES)
    uncertainties = dict(uncertainties or DEFAULT_UNCERTAINTIES)
    curve = power_curve if power_curve is not None else default_power_curve(
        inputs.rated_power_mw, inputs.cut_in_speed, inputs.rated_speed, inputs.cut_out_speed)
    layout_df = layout if layout is not None else default_layout(inputs.number_of_turbines)
    hourly = generate_hourly_wind(inputs)
    per_turbine_mw = interpolate_power(hourly["Wind Speed (m/s)"], curve, inputs.air_density)
    gross_mwh = per_turbine_mw * float(inputs.number_of_turbines)
    hourly["Power Output (MW)"] = per_turbine_mw * float(inputs.number_of_turbines)
    hourly["Gross Energy (MWh)"] = gross_mwh
    waterfall, net_aep = apply_losses(float(hourly["Gross Energy (MWh)"].sum()), losses)
    total_loss_fraction = 1.0 - net_aep / max(float(hourly["Gross Energy (MWh)"].sum()), 1e-6)
    hourly["Net Energy (MWh)"] = hourly["Gross Energy (MWh)"] * (1.0 - total_loss_fraction)
    hourly["Wake Loss (MWh)"] = hourly["Gross Energy (MWh)"] * sum(
        losses.get(k, 0.0) for k in losses if "Wake" in k or k in {"Blockage", "Turbulence"}) / 100.0
    hourly["Availability"] = 1.0 - sum(losses.get(k, 0.0) for k in losses if k in {
        "Scheduled maintenance", "Forced outages", "Manufacturer availability", "Grid availability"}) / 100.0
    hourly["Curtailment (MWh)"] = hourly["Gross Energy (MWh)"] * sum(
        losses.get(k, 0.0) for k in losses if "Curtailment" in k or k in {
            "Grid restrictions", "Congestion", "Market curtailment", "Operator instructions"}) / 100.0
    hourly["Grid Export (MWh)"] = hourly["Net Energy (MWh)"]

    monthly = hourly.assign(Month=hourly["Timestamp"].dt.month).groupby("Month", as_index=False).agg(
        Gross=("Gross Energy (MWh)", "sum"),
        Net=("Net Energy (MWh)", "sum"),
    )
    monthly["Month"] = [MONTH_NAMES[i - 1] for i in monthly["Month"]]
    monthly["Loss %"] = 100.0 * (1.0 - monthly["Net"] / monthly["Gross"].clip(lower=1e-6))

    installed_mw = inputs.rated_power_mw * inputs.number_of_turbines
    gross_aep = float(hourly["Gross Energy (MWh)"].sum())
    total_unc = rss(uncertainties)
    p_levels = pd.DataFrame([
        {
            "P-level": level,
            "Net AEP (MWh)": net_aep * (1.0 + z * total_unc / 100.0),
            "Capacity Factor %": 100.0 * net_aep * (1.0 + z * total_unc / 100.0) / (installed_mw * 8760.0),
        }
        for level, z in Z_LEVELS.items()
    ])
    overview = {
        "mean_wind_speed_hub": float(hourly["Wind Speed (m/s)"].mean()),
        "gross_aep_mwh": gross_aep,
        "gross_cf_pct": 100.0 * gross_aep / (installed_mw * 8760.0),
        "gross_specific_yield_mwh_per_mw": gross_aep / installed_mw,
        "net_aep_mwh": net_aep,
        "net_cf_pct": 100.0 * net_aep / (installed_mw * 8760.0),
        "net_specific_yield_mwh_per_mw": net_aep / installed_mw,
        "export_energy_mwh": net_aep,
        "internal_consumption_mwh": float(waterfall.loc[waterfall["Stage"].eq("Auxiliary consumption"), "Loss MWh"].sum()),
        "installed_mw": installed_mw,
        "total_uncertainty_pct": total_unc,
    }
    return {
        "inputs": inputs,
        "overview": overview,
        "waterfall": waterfall,
        "monthly": monthly,
        "hourly": hourly,
        "p_levels": p_levels,
        "layout": layout_df,
        "power_curve": curve,
        "losses": losses,
        "uncertainties": uncertainties,
    }


def scenario_comparison(results: Mapping[str, dict]) -> pd.DataFrame:
    rows = []
    for name, res in results.items():
        overview = res["overview"]
        p90 = res["p_levels"].set_index("P-level").loc["P90", "Net AEP (MWh)"]
        rows.append({
            "Scenario": name,
            "Net AEP (GWh)": overview["net_aep_mwh"] / 1000.0,
            "P90 (GWh)": float(p90) / 1000.0,
            "CF %": overview["net_cf_pct"],
            "Total uncertainty %": overview["total_uncertainty_pct"],
        })
    return pd.DataFrame(rows)
