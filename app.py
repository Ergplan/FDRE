"""Enterprise FDRE tender optimization app.

Run from this folder:
    streamlit run app.py
"""
from __future__ import annotations

import io
import json
import os
import hashlib
import zipfile

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

import fdre_enterprise_engine as E
import fdre_eya as YA
import fdre_wind_eya as WYA

st.set_page_config(page_title="Enterprise FDRE Optimizer", layout="wide", page_icon="⚡")

MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
PVSYST_SAMPLE_PATH = "/Users/rachitagarwal/Downloads/NHPC Bikaner.pdf"
PVSYST_SAMPLE_PATHS = [
    "/Users/rachitagarwal/Downloads/NHPC Bikaner.pdf",
    "/Users/rachitagarwal/Downloads/NHPC Bikaner 1.pdf",
]
WIND_GENERATION_SAMPLE_PATH = "/Users/rachitagarwal/Downloads/Wind Generation Bikaner.csv"
MAX_PVSYST_SITES = 3


def _json_key(project: E.ProjectConfig) -> str:
    return json.dumps(E.project_to_dict(project), sort_keys=True)


def _sizing_basis_key(project: E.ProjectConfig) -> str:
    data = E.project_to_dict(project)
    data.pop("finance", None)
    for gen in data.get("generators", []):
        gen.pop("capex_cr_per_mw", None)
        gen.pop("opex_lakh_per_mw_year", None)
    for bess in data.get("bess", []):
        bess.pop("capex_cr_per_mwh", None)
        bess.pop("pcs_capex_cr_per_mw", None)
        bess.pop("opex_lakh_per_mwh_year", None)
    tender = data.get("tender", {})
    for key in (
        "penalty_multiplier",
        "psm_charge_rs_per_kwh",
        "trading_margin_rs_per_kwh",
        "success_charge_lakh_per_mw",
        "success_charge_gst",
        "external_green_price_rs_per_kwh",
    ):
        tender.pop(key, None)
    simulation = data.get("simulation", {})
    for key in ("merchant_price_rs_per_kwh", "merchant_escalation"):
        simulation.pop(key, None)
    return json.dumps(data, sort_keys=True)


@st.cache_data(show_spinner=False)
def _evaluate_cached(project_json: str, years: tuple[int, ...], custom_cf: pd.DataFrame | None = None):
    project = E.project_from_dict(json.loads(project_json))
    return E.evaluate_project(project, years=years, custom_cf=custom_cf)


@st.cache_data(show_spinner=False)
def _dispatch_cached(project_json: str, year: int, custom_cf: pd.DataFrame | None = None):
    project = E.project_from_dict(json.loads(project_json))
    return E.dispatch_project_year(project, year=year, custom_cf=custom_cf, return_hourly=True)


@st.cache_data(show_spinner=False)
def _full_term_dispatch_cached(project_json: str, custom_cf: pd.DataFrame | None = None):
    project = E.project_from_dict(json.loads(project_json))
    return E.full_term_dispatch_tables(project, custom_cf=custom_cf, include_hourly=True)


def _make_dispatch_zip(project_json: str, annual_csv: bytes, monthly_csv: bytes, hourly_csv: bytes) -> bytes:
    readme = (
        "FDRE full PPA-term dispatch export\n"
        "\n"
        "Files included:\n"
        "- fdre_hourly_dispatch_ppa_term.csv: every modelled hour for every PPA year; "
        "includes year, hour_of_ppa, day_of_ppa, month/day/hour, resource generation, "
        "peak target, PPA energy, BESS charge/discharge/SOC, merchant energy and spill.\n"
        "- fdre_yearly_dispatch_ppa_term.csv: one operating/compliance summary row for each PPA year.\n"
        "- fdre_monthly_compliance_ppa_term.csv: monthly peak availability and shortfall table for every PPA year.\n"
        "- current_fdre_project_config.json: the exact project configuration used to create the export.\n"
    ).encode("utf-8")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("fdre_hourly_dispatch_ppa_term.csv", hourly_csv)
        zf.writestr("fdre_yearly_dispatch_ppa_term.csv", annual_csv)
        zf.writestr("fdre_monthly_compliance_ppa_term.csv", monthly_csv)
        zf.writestr("current_fdre_project_config.json", project_json.encode("utf-8"))
        zf.writestr("README_export.txt", readme)
    return buffer.getvalue()


def _profile_key(custom_cf: pd.DataFrame | None) -> str:
    if custom_cf is None or custom_cf.empty:
        return "none"
    hashes = pd.util.hash_pandas_object(custom_cf.reset_index(drop=True), index=True).to_numpy()
    return hashlib.sha256(hashes.tobytes()).hexdigest()


def _active_wind_generation_profile() -> tuple[pd.DataFrame | None, str, str]:
    if not st.session_state.get("wind_generation_use_in_model", False):
        return None, "", "none"
    report = st.session_state.get("wind_generation_report")
    if not report:
        return None, "", "none"
    level = st.session_state.get("wind_generation_level", "P50")
    custom_cf = WYA.wind_generation_custom_cf(report, level)
    if custom_cf is None:
        return None, "", "none"
    summary = report["summary"].set_index("P-level").loc[level]
    source = os.path.basename(str(report.get("source_name", "wind generation CSV")))
    note = (
        f"Wind model input: {source}, {level}, "
        f"{summary['Per-turbine AEP (GWh)']:.2f} GWh/turbine, "
        f"{summary['Capacity factor %']:.2f}% CF on {report['rated_power_mw']:.2f} MW WTG."
    )
    return custom_cf, note, f"{level}:{_profile_key(custom_cf)}"


def _optimizer_best_for_current(project: E.ProjectConfig, custom_cf_key: str = "none"):
    best = st.session_state.get("optimizer_best")
    if not isinstance(best, dict):
        return None
    current_key = f"{_sizing_basis_key(project)}|profile={custom_cf_key}"
    if best.get("source_sizing_basis_key") == current_key:
        return best
    if best.get("source_sizing_basis_key") is None and custom_cf_key == "none" and best.get("source_project_key") == _json_key(project):
        best["source_sizing_basis_key"] = current_key
        return best
    if isinstance(best.get("source_project_key"), str):
        try:
            source_project = E.project_from_dict(json.loads(best["source_project_key"]))
            if best.get("source_sizing_basis_key") is None and custom_cf_key == "none" and _sizing_basis_key(source_project) == _sizing_basis_key(project):
                best["source_sizing_basis_key"] = current_key
                return best
        except Exception:
            pass
    return None


def _with_exact_ppa_solve(best: dict, custom_cf: pd.DataFrame | None = None) -> dict:
    project_best = best["project"]
    exact_years = tuple(range(1, project_best.tender.ppa_years + 1))
    exact = E.evaluate_project(project_best, years=exact_years, custom_cf=custom_cf)
    best["exact_operating"] = exact["operating"]
    best["exact_first_year_dispatch"] = exact["first_year_dispatch"]
    best["exact_tariff"] = exact["tariff"]
    best["exact_finance"] = exact["finance"]
    best["exact_status"] = exact["status"]
    return best


def _optimized_payload(project: E.ProjectConfig, custom_cf_key: str = "none") -> dict | None:
    best = _optimizer_best_for_current(project, custom_cf_key)
    if best is None:
        return None
    project_best = best["project"]
    return {
        "best": best,
        "project": project_best,
        "cap_summary": E.project_capacity_summary(project_best),
        "operating": best.get("exact_operating", best.get("operating")),
        "first_year_dispatch": best.get("exact_first_year_dispatch", best.get("first_year_dispatch")),
        "tariff": best.get("exact_tariff", best.get("tariff", float("nan"))),
        "finance": best.get("exact_finance", best.get("finance")),
        "status": best.get("exact_status", best.get("status", {})),
    }


def _status_text(ok: bool) -> str:
    return "Pass" if bool(ok) else "Fail"


def _fmt_dscr(value: float) -> str:
    if not np.isfinite(value):
        return "N/A"
    return f"{value:.2f}x"


def _fixed_sizing_project_with_current_finance(
    optimized_project: E.ProjectConfig,
    current_project: E.ProjectConfig,
) -> E.ProjectConfig:
    fixed = E.project_from_dict(E.project_to_dict(optimized_project))
    fixed.finance = current_project.finance
    fixed.simulation.merchant_price_rs_per_kwh = current_project.simulation.merchant_price_rs_per_kwh
    fixed.simulation.merchant_escalation = current_project.simulation.merchant_escalation
    fixed.tender.penalty_multiplier = current_project.tender.penalty_multiplier
    fixed.tender.psm_charge_rs_per_kwh = current_project.tender.psm_charge_rs_per_kwh
    fixed.tender.trading_margin_rs_per_kwh = current_project.tender.trading_margin_rs_per_kwh
    fixed.tender.success_charge_lakh_per_mw = current_project.tender.success_charge_lakh_per_mw
    fixed.tender.success_charge_gst = current_project.tender.success_charge_gst
    fixed.tender.external_green_price_rs_per_kwh = current_project.tender.external_green_price_rs_per_kwh

    current_gens = {g.name: g for g in current_project.generators}
    for gen in fixed.generators:
        source = current_gens.get(gen.name)
        if source is not None:
            gen.capex_cr_per_mw = source.capex_cr_per_mw
            gen.opex_lakh_per_mw_year = source.opex_lakh_per_mw_year

    current_bess = {b.name: b for b in current_project.bess}
    for bess in fixed.bess:
        source = current_bess.get(bess.name)
        if source is not None:
            bess.capex_cr_per_mwh = source.capex_cr_per_mwh
            bess.pcs_capex_cr_per_mw = source.pcs_capex_cr_per_mw
            bess.opex_lakh_per_mwh_year = source.opex_lakh_per_mwh_year

    return fixed


def _solar_generator_matches_pvsyst_target(gen: E.GeneratorSpec, target: str) -> bool:
    if gen.technology.lower() != "solar":
        return False
    safe_target = E._safe_name(target).lower()
    safe_name = E._safe_name(gen.name).lower()
    if safe_name == safe_target or safe_name.startswith(safe_target + "_"):
        return True
    if "iii" in safe_target and "iii" in safe_name:
        return True
    if "iii" not in safe_target and "ii" in safe_target and "ii" in safe_name and "iii" not in safe_name:
        return True
    return False


def _pvsyst_slots() -> list[dict]:
    slots = st.session_state.get("pvsyst_reports")
    if not slots and st.session_state.get("pvsyst_report"):
        slots = [{"report": st.session_state["pvsyst_report"]}]
        st.session_state["pvsyst_reports"] = slots
    return list(slots or [])[:MAX_PVSYST_SITES]


def _pvsyst_slot_target(slot_index: int, project: E.ProjectConfig) -> str:
    solar_names = [g.name for g in project.generators if g.technology.lower() == "solar"]
    if slot_index == 0:
        for name in solar_names:
            if "ii" in E._safe_name(name).lower() and "iii" not in E._safe_name(name).lower():
                return name
    if slot_index == 1:
        for name in solar_names:
            if "iii" in E._safe_name(name).lower():
                return name
    if slot_index < len(solar_names):
        return solar_names[slot_index]
    return f"PVsyst_Site_{slot_index + 1}_Solar"


def _pvsyst_slot_node(slot_index: int, project: E.ProjectConfig) -> str:
    solar_nodes = [g.node for g in project.generators if g.technology.lower() == "solar"]
    if slot_index < len(solar_nodes):
        return solar_nodes[slot_index]
    return project.nodes[0].name if project.nodes else ""


def _pvsyst_site_display(slot: dict, idx: int) -> str:
    report = slot.get("report", {})
    return str(report.get("source_name") or report.get("project") or report.get("site") or f"PVsyst site {idx + 1}")


def _pvsyst_active_inputs(project: E.ProjectConfig, flag_prefix: str) -> list[dict]:
    active = []
    for idx, slot in enumerate(_pvsyst_slots()):
        report = slot.get("report")
        if not report or not st.session_state.get(f"{flag_prefix}_{idx}", False):
            continue
        target = st.session_state.get(f"pvsyst_site_{idx}_target", _pvsyst_slot_target(idx, project))
        level = st.session_state.get(f"pvsyst_site_{idx}_level", "P50")
        uncertainty = float(st.session_state.get(f"pvsyst_site_{idx}_uncertainty", 4.87))
        node = st.session_state.get(f"pvsyst_site_{idx}_node", _pvsyst_slot_node(idx, project))
        active.append({
            "index": idx,
            "slot": slot,
            "report": report,
            "target": target,
            "level": level,
            "uncertainty": uncertainty,
            "node": node,
        })
    return active


def _pvsyst_model_generators(project: E.ProjectConfig) -> list[E.GeneratorSpec]:
    gens = []
    seen = set()
    for item in _pvsyst_active_inputs(project, "pvsyst_site_model_enabled"):
        target = item["target"]
        for gen in project.generators:
            if _solar_generator_matches_pvsyst_target(gen, target) and gen.name not in seen:
                gens.append(gen)
                seen.add(gen.name)
    return gens


def _project_with_pvsyst_model_input(project: E.ProjectConfig) -> tuple[E.ProjectConfig, str | None]:
    active = _pvsyst_active_inputs(project, "pvsyst_site_model_enabled")
    if not active:
        return project, None

    p = E.project_from_dict(E.project_to_dict(project))
    notes = []
    for item in active:
        report = item["report"]
        target = item["target"]
        level = item["level"]
        uncertainty = item["uncertainty"]
        metrics = YA.pvsyst_level_metrics(report, level=level, uncertainty_pct=uncertainty)
        matched = []
        for gen in p.generators:
            if not _solar_generator_matches_pvsyst_target(gen, target):
                continue
            gen.ac_mw = float(report.get("ac_mw") or gen.ac_mw)
            gen.dc_mwp = float(report.get("dc_mwp") or gen.dc_mwp)
            gen.cuf = float(metrics["ac_cuf"])
            gen.notes = (
                f"PVsyst {level} model input from {report.get('source_name') or report.get('project')}: "
                f"{metrics['mwh_y1']:.0f} MWh Y1, AC CUF {100 * metrics['ac_cuf']:.2f}%"
            )
            matched.append(gen.name)
        if not matched:
            safe_target = E._safe_name(target)
            node = item["node"] or (p.nodes[0].name if p.nodes else "")
            gen = E.GeneratorSpec(
                name=safe_target,
                technology="solar",
                node=node,
                ac_mw=float(report.get("ac_mw") or 0.0),
                dc_mwp=float(report.get("dc_mwp") or 0.0),
                cuf=float(metrics["ac_cuf"]),
                degradation_per_year=0.004,
                capex_cr_per_mw=project.finance.default_solar_capex_cr_per_mw_ac,
                opex_lakh_per_mw_year=5.5,
                merchant_price_factor=0.85,
                notes=(
                    f"PVsyst {level} model input from {report.get('source_name') or report.get('project')}: "
                    f"{metrics['mwh_y1']:.0f} MWh Y1, AC CUF {100 * metrics['ac_cuf']:.2f}%"
                ),
            )
            p.generators.append(gen)
            matched = [gen.name]

        source = report.get("source_name") or report.get("project") or "PVsyst report"
        notes.append(
            f"{source} -> {', '.join(matched)} at {level}: "
            f"{metrics['mwh_y1']:,.0f} MWh Y1, AC CUF {100 * metrics['ac_cuf']:.2f}%"
        )
    return p, "PVsyst model inputs applied: " + "; ".join(notes) + "."


def load_project_from_upload() -> E.ProjectConfig:
    uploaded = st.sidebar.file_uploader("Optional: upload project JSON", type="json")
    if uploaded is None:
        return E.default_fdre2_project()
    try:
        return E.project_from_dict(json.loads(uploaded.getvalue().decode("utf-8")))
    except Exception as exc:
        st.sidebar.error(f"Could not read JSON. Using default configuration. {exc}")
        return E.default_fdre2_project()


def apply_sidebar(project: E.ProjectConfig) -> E.ProjectConfig:
    p = E.project_from_dict(E.project_to_dict(project))
    st.sidebar.title("Enterprise FDRE Optimizer")
    st.sidebar.caption("Model the uploaded NHPC FDRE RfS against the Rajasthan project configuration.")

    with st.sidebar.expander("Tender / offtake", expanded=True):
        p.tender.contracted_capacity_mw = st.number_input(
            "Contracted capacity (MW)", 50.0, 600.0, p.tender.contracted_capacity_mw, 10.0
        )
        p.tender.declared_annual_cuf = st.slider(
            "Declared annual CUF", 40.0, 70.0, p.tender.declared_annual_cuf * 100.0, 0.5
        ) / 100.0
        p.tender.peak_schedule_mode = st.selectbox(
            "Peak schedule mode", ["fixed", "worst_deficit_daily"],
            index=0 if p.tender.peak_schedule_mode == "fixed" else 1,
            help="worst_deficit_daily selects the two weakest hours in each RfS morning/evening band each day."
        )
        p.tender.fixed_morning_peak_hours = tuple(st.multiselect(
            "Fixed morning peak hours", list(range(5, 10)), list(p.tender.fixed_morning_peak_hours), max_selections=2
        ) or list(p.tender.fixed_morning_peak_hours))  # type: ignore[arg-type]
        p.tender.fixed_evening_peak_hours = tuple(st.multiselect(
            "Fixed evening peak hours", list(range(18, 23)), list(p.tender.fixed_evening_peak_hours), max_selections=2
        ) or list(p.tender.fixed_evening_peak_hours))  # type: ignore[arg-type]
        p.finance.hard_compliance_required = st.checkbox("Require zero modeled penalty MWh", p.finance.hard_compliance_required)
        p.tender.allow_external_green_purchase = st.checkbox("Allow up to 5% external green support", p.tender.allow_external_green_purchase)
        if p.tender.allow_external_green_purchase:
            p.tender.external_green_price_rs_per_kwh = st.number_input(
                "External green price (Rs/kWh)", 0.0, 20.0, p.tender.external_green_price_rs_per_kwh, 0.05
            )

    with st.sidebar.expander("Resource assumptions", expanded=False):
        for gen in p.generators:
            gen.cuf = st.slider(f"{gen.name} CUF", 10.0, 50.0, gen.cuf * 100.0, 0.5) / 100.0
            gen.degradation_per_year = st.number_input(
                f"{gen.name} degradation %/yr", 0.0, 2.5, gen.degradation_per_year * 100.0, 0.1
            ) / 100.0
        p.simulation.seed = int(st.number_input("Weather seed", 0, 99999, p.simulation.seed, 1))
        p.simulation.solar_variability = st.slider("Solar variability", 0.0, 0.30, p.simulation.solar_variability, 0.01)
        p.simulation.wind_variability = st.slider("Wind variability", 0.0, 0.60, p.simulation.wind_variability, 0.02)

    with st.sidebar.expander("Finance", expanded=False):
        p.finance.target_equity_irr = st.slider("Target equity IRR", 8.0, 22.0, p.finance.target_equity_irr * 100.0, 0.25) / 100.0
        p.finance.min_dscr = st.number_input("Minimum DSCR", 1.0, 1.6, p.finance.min_dscr, 0.05)
        p.finance.debt_fraction = st.slider("Debt fraction", 40.0, 85.0, p.finance.debt_fraction * 100.0, 1.0) / 100.0
        p.finance.interest_rate = st.number_input("Debt interest rate", 5.0, 14.0, p.finance.interest_rate * 100.0, 0.05) / 100.0
        p.finance.debt_tenor_years = int(st.number_input("Debt tenor", 8, 25, p.finance.debt_tenor_years, 1))
        p.finance.land_and_development_cr = st.number_input("Land/development (cr)", 0.0, 1000.0, p.finance.land_and_development_cr, 10.0)
        p.finance.transmission_lump_sum_cr = st.number_input("Transmission lump sum (cr)", 0.0, 1000.0, p.finance.transmission_lump_sum_cr, 10.0)
        p.finance.owner_costs_cr = st.number_input("Owner costs (cr)", 0.0, 500.0, p.finance.owner_costs_cr, 5.0)
        p.finance.contingency_percent = st.number_input("Contingency %", 0.0, 15.0, p.finance.contingency_percent * 100.0, 0.25) / 100.0
        p.simulation.merchant_price_rs_per_kwh = st.number_input("Merchant price Yr-1 (Rs/kWh)", 0.0, 20.0, p.simulation.merchant_price_rs_per_kwh, 0.05)
        p.simulation.merchant_escalation = st.number_input("Merchant escalation %", 0.0, 8.0, p.simulation.merchant_escalation * 100.0, 0.25) / 100.0

    with st.sidebar.expander("Capex unit rates", expanded=False):
        p.finance.default_solar_capex_cr_per_mw_ac = st.number_input("Solar EPC default (cr/MWac)", 1.5, 6.0, p.finance.default_solar_capex_cr_per_mw_ac, 0.05)
        p.finance.default_wind_capex_cr_per_mw = st.number_input("Wind EPC default (cr/MW)", 4.0, 11.0, p.finance.default_wind_capex_cr_per_mw, 0.05)
        p.finance.default_bess_capex_cr_per_mwh = st.number_input("BESS energy default (cr/MWh)", 0.2, 3.0, p.finance.default_bess_capex_cr_per_mwh, 0.05)
        p.finance.default_bess_pcs_capex_cr_per_mw = st.number_input("BESS PCS default (cr/MW)", 0.0, 1.5, p.finance.default_bess_pcs_capex_cr_per_mw, 0.05)
        for gen in p.generators:
            default = p.finance.default_solar_capex_cr_per_mw_ac if gen.technology == "solar" else p.finance.default_wind_capex_cr_per_mw
            gen.capex_cr_per_mw = st.number_input(f"{gen.name} capex (cr/MW)", 0.0, 12.0, gen.capex_cr_per_mw or default, 0.05)
        for b in p.bess:
            b.capex_cr_per_mwh = st.number_input(f"{b.name} battery capex (cr/MWh)", 0.0, 3.0, b.capex_cr_per_mwh, 0.05)
            b.pcs_capex_cr_per_mw = st.number_input(f"{b.name} PCS capex (cr/MW)", 0.0, 2.0, b.pcs_capex_cr_per_mw, 0.05)

    return p


base_project = load_project_from_upload()
project = apply_sidebar(base_project)
project, pvsyst_model_note = _project_with_pvsyst_model_input(project)
wind_custom_cf, wind_model_note, wind_profile_key = _active_wind_generation_profile()
project_json = _json_key(project)
solve_mode = st.sidebar.radio(
    "Operating solve mode",
    ["Fast representative years", "Exact full PPA term"],
    help=(
        "Fast mode simulates years 1, 5, 10, 15, 20 and 25 and interpolates the rest. "
        "Exact mode simulates every PPA year for audit-quality operating and finance tables."
    ),
)
years = tuple(range(1, project.tender.ppa_years + 1)) if solve_mode == "Exact full PPA term" else (1, 5, 10, 15, 20, 25)

st.title("⚡ Enterprise FDRE Optimization Engine")
st.caption("Multi-node hourly dispatch, RfS compliance, project finance and bid tariff optimization in one folder.")
st.caption(f"Operating solve: {solve_mode}. Capacity optimizer uses a HiGHS LP seed plus nonlinear dispatch/finance evaluation.")
if pvsyst_model_note:
    st.info(pvsyst_model_note)
if wind_model_note:
    st.info(wind_model_note)

with st.spinner("Running dispatch and tariff solve..."):
    result = _evaluate_cached(project_json, years, wind_custom_cf)

cap_summary = E.project_capacity_summary(project)
status = result["status"]
fin = result["finance"]
op = result["operating"]
first = result["first_year_dispatch"]
optimizer_best = _optimizer_best_for_current(project, wind_profile_key)
optimizer_just_completed = bool(st.session_state.pop("optimizer_just_completed", False))

warnings = project.validate()
if warnings:
    with st.expander("Model validation warnings", expanded=True):
        for w in warnings:
            st.write("- " + w)

opt_tab, compliance_tab, finance_tab, custom_tab, project_tab, dispatch_tab, pvsyst_tab, wind_eya_tab, eya_tab, export_tab = st.tabs([
    "Optimized Results", "Tender Compliance", "Finance", "Custom Results", "Project Inputs", "Dispatch", "PVsyst Report", "Wind EYA", "EYA Report", "Exports"
])

with opt_tab:
    st.subheader("Optimized FDRE Bid Result")
    st.caption(
        "This tab is the bid-sizing output. The optimizer uses a HiGHS LP seed, nonlinear hourly dispatch/finance evaluation, "
        "and then re-solves the selected best case over the full 25-year PPA term."
    )
    base = E.project_capacity_summary(project)
    pvsyst_opt_gens = _pvsyst_model_generators(project)
    c1, c2 = st.columns(2)
    with c1:
        wind_bounds = st.slider("Wind bounds (MW)", 0.0, 150.0, (max(0.0, base["wind_mw"] * 0.5), max(10.0, base["wind_mw"] * 2.0)), 1.0)
        pvsyst_solar_bounds = {}
        if pvsyst_opt_gens:
            st.caption("PVsyst solar sites are sized individually by the optimizer.")
            for gen in pvsyst_opt_gens:
                hi = max(gen.ac_mw + 5.0, min(800.0, gen.ac_mw * 1.5))
                pvsyst_solar_bounds[E._generator_capacity_key(gen)] = st.slider(
                    f"{gen.name} AC bounds (MW)", 0.0, 800.0,
                    (max(0.0, gen.ac_mw * 0.75), hi), 5.0,
                    key=f"opt_bound_{E._safe_name(gen.name)}")
        else:
            solar_bounds = st.slider("Solar AC bounds (MW)", 0.0, 800.0, (max(0.0, base["solar_ac_mw"] * 0.75), min(800.0, base["solar_ac_mw"] * 1.5)), 5.0)
        contracted_bounds = st.slider("Contracted capacity bounds (MW)", 50.0, 600.0, (max(50.0, project.tender.contracted_capacity_mw - 50.0), min(600.0, project.tender.contracted_capacity_mw + 50.0)), 10.0)
    with c2:
        bp_bounds = st.slider("BESS power bounds (MW)", 0.0, 500.0, (max(0.0, base["bess_power_mw"] * 0.8), min(500.0, base["bess_power_mw"] * 1.5)), 5.0)
        be_bounds = st.slider("BESS energy bounds (MWh)", 0.0, 2000.0, (max(0.0, base["bess_energy_mwh"] * 0.8), min(2000.0, base["bess_energy_mwh"] * 1.5)), 10.0)
        effort = st.select_slider("Effort", ["Fast", "Balanced", "Thorough"], "Fast")
    effort_map = {"Fast": (0, 1), "Balanced": (1, 1), "Thorough": (1, 2)}
    if st.button("Run optimizer and full 25-year PPA solve", type="primary"):
        bounds = {
            "wind_mw": wind_bounds,
            "bess_power_mw": bp_bounds,
            "bess_energy_mwh": be_bounds,
            "contracted_capacity_mw": contracted_bounds,
        }
        if pvsyst_opt_gens:
            bounds.update(pvsyst_solar_bounds)
        else:
            bounds["solar_ac_mw"] = solar_bounds
        maxiter, popsize = effort_map[effort]
        with st.spinner("Optimizing capacity and running exact 25-year PPA solve..."):
            opt_project = E.project_from_dict(E.project_to_dict(project))
            opt_project.simulation.circular_soc_iterations = 1
            best = E.optimize_capacity(
                opt_project,
                bounds,
                maxiter=maxiter,
                popsize=popsize,
                seed=project.simulation.seed,
                polish=(effort != "Fast"),
                custom_cf=wind_custom_cf,
            )
            best = _with_exact_ppa_solve(best, custom_cf=wind_custom_cf)
            best["source_project_key"] = project_json
            best["source_sizing_basis_key"] = f"{_sizing_basis_key(project)}|profile={wind_profile_key}"
            st.session_state["optimizer_best"] = best
            st.session_state["optimizer_just_completed"] = True
            st.rerun()

    opt_payload = _optimized_payload(project, wind_profile_key)
    if opt_payload is None:
        st.info("Run the optimizer to generate the optimized FDRE result. Custom/sidebar cases are shown in the Custom Results tab.")
    else:
        if optimizer_just_completed:
            st.success("Optimization and full 25-year PPA solve complete")
        display_best = opt_payload["best"]
        exact_tariff = opt_payload["tariff"]
        exact_status = opt_payload["status"]
        best_cap = opt_payload["cap_summary"]

        k1, k2, k3, k4, k5 = st.columns(5)
        k1.metric("Optimized contracted capacity", f"{best_cap['contracted_capacity_mw']:.0f} MW")
        k2.metric("Optimized solar / wind", f"{best_cap['solar_ac_mw']:.0f} / {best_cap['wind_mw']:.1f} MW")
        k3.metric("Optimized BESS", f"{best_cap['bess_power_mw']:.0f} MW / {best_cap['bess_usable_poi_mwh_y1']:.0f} MWh")
        k4.metric("Min peak availability", f"{exact_status.get('min_monthly_peak_availability', float('nan')):.1%}")
        k5.metric("Optimized required gross tariff", "Infeasible" if not np.isfinite(exact_tariff) else f"Rs {exact_tariff:.2f}/kWh")

        st.subheader("Optimized Capacity Summary")
        st.dataframe(pd.DataFrame([best_cap]).T.rename(columns={0: "value"}), width="stretch")
        st.caption("Tender validation and project financials are available in the Tender Compliance and Finance tabs.")

        st.subheader("Optimizer Solver Details")
        st.json(display_best["optimizer"])
        optimized_config = json.dumps(E.project_to_dict(display_best["project"]), indent=2).encode("utf-8")
        st.download_button(
            "Download optimized project JSON",
            optimized_config,
            file_name="fdre_optimized_project_config.json",
            mime="application/json",
            key="optimized_results_download_json",
        )

with compliance_tab:
    st.subheader("Optimized Tender Compliance Dashboard")
    opt_payload = _optimized_payload(project, wind_profile_key)
    if opt_payload is None:
        st.info("Run the optimizer first. This dashboard validates the optimized full-PPA output, not the custom/sidebar case.")
    else:
        opt_project = opt_payload["project"]
        opt_op = opt_payload["operating"]
        opt_status = opt_payload["status"]
        opt_first = opt_payload["first_year_dispatch"]
        checklist = E.compliance_checklist(opt_project, opt_op).copy()
        checklist["status"] = checklist["pass"].map(lambda ok: _status_text(bool(ok)))
        passed = int(checklist["pass"].sum())
        total = int(len(checklist))
        total_penalty = float(opt_status.get("total_penalty_mwh", opt_op["total_penalty_mwh"].sum()))
        peak_floor = opt_project.tender.peak_availability_floor
        cuf_floor = opt_project.tender.annual_cuf_floor
        min_peak = float(opt_status.get("min_monthly_peak_availability", opt_op["min_monthly_peak_availability"].min()))
        min_cuf = float(opt_status.get("min_annual_cuf", opt_op["annual_cuf"].min()))

        d1, d2, d3, d4, d5 = st.columns(5)
        d1.metric("Tender checks passed", f"{passed}/{total}")
        d2.metric("Peak availability", f"{min_peak:.1%}", delta=f"floor {peak_floor:.0%}", delta_color="off")
        d3.metric("Annual CUF", f"{min_cuf:.1%}", delta=f"floor {cuf_floor:.1%}", delta_color="off")
        d4.metric("Penalty MWh", f"{total_penalty:,.0f}")
        d5.metric("Compliance status", "Pass" if passed == total and total_penalty <= 1e-6 else "Review")

        st.subheader("Hard Tender Conditions")
        st.dataframe(checklist[["check", "status", "evidence"]], width="stretch", hide_index=True)

        st.subheader("25-Year Compliance Trend")
        trend = opt_op[[
            "year", "annual_cuf", "min_monthly_peak_availability",
            "peak_penalty_mwh", "annual_penalty_mwh", "total_penalty_mwh",
        ]].copy()
        trend["peak_availability_pass"] = trend["min_monthly_peak_availability"] + 1e-9 >= peak_floor
        trend["annual_cuf_pass"] = trend["annual_cuf"] + 1e-9 >= cuf_floor
        trend["penalty_free"] = trend["total_penalty_mwh"].abs() <= 1e-6
        st.dataframe(trend, width="stretch", hide_index=True)

        fig = go.Figure()
        fig.add_scatter(x=trend["year"], y=trend["min_monthly_peak_availability"], mode="lines+markers", name="Min monthly peak availability")
        fig.add_scatter(x=trend["year"], y=[peak_floor] * len(trend), mode="lines", name="Peak floor")
        fig.add_scatter(x=trend["year"], y=trend["annual_cuf"], mode="lines+markers", name="Annual CUF")
        fig.add_scatter(x=trend["year"], y=[cuf_floor] * len(trend), mode="lines", name="CUF floor")
        fig.update_yaxes(tickformat=".0%", range=[0, 1.05])
        fig.update_layout(height=420, margin=dict(l=20, r=20, t=20, b=20), xaxis_title="PPA year")
        st.plotly_chart(fig, width="stretch", key="optimized_compliance_trend_chart")

        if opt_first is not None and getattr(opt_first, "monthly", None) is not None:
            monthly_opt = opt_first.monthly.copy()
            monthly_opt["month_name"] = [MONTH_NAMES[i - 1] for i in monthly_opt["month"]]
            st.subheader("First-Year Monthly Peak Availability")
            mfig = go.Figure()
            mfig.add_bar(x=monthly_opt["month_name"], y=monthly_opt["peak_availability"], name="Availability")
            mfig.add_scatter(x=monthly_opt["month_name"], y=[peak_floor] * len(monthly_opt), mode="lines", name="RfS floor")
            mfig.update_yaxes(tickformat=".0%", range=[0, 1.05])
            mfig.update_layout(height=360, margin=dict(l=20, r=20, t=20, b=20))
            st.plotly_chart(mfig, width="stretch", key="optimized_monthly_peak_chart")
            st.dataframe(
                monthly_opt[[
                    "month_name", "peak_obligation_mwh", "peak_delivered_mwh",
                    "external_green_mwh", "peak_shortfall_mwh", "peak_availability", "compliant",
                ]],
                width="stretch",
                hide_index=True,
            )

with finance_tab:
    st.subheader("Fixed Optimized Sizing Finance Rerun")
    opt_payload = _optimized_payload(project, wind_profile_key)
    if opt_payload is None:
        st.info("Run the optimizer first. After that, this page will keep optimized MW/MWh sizing fixed and recalculate only financial outputs from the current sidebar finance assumptions.")
    else:
        fixed_finance_project = _fixed_sizing_project_with_current_finance(opt_payload["project"], project)
        opt_operating = opt_payload["operating"]
        base_tariff = opt_payload["tariff"]
        with st.expander("Finance rerun inputs - fixed optimized sizing", expanded=True):
            st.caption("These inputs rerun only tariff, IRR, DSCR and cashflows. Optimized MW/MWh and dispatch remain locked.")
            r1, r2, r3 = st.columns(3)
            with r1:
                fixed_finance_project.finance.interest_rate = st.number_input(
                    "Debt interest rate for rerun (%)",
                    min_value=0.0,
                    max_value=25.0,
                    value=fixed_finance_project.finance.interest_rate * 100.0,
                    step=0.05,
                    key="fixed_finance_interest_rate_pct",
                ) / 100.0
                fixed_finance_project.finance.debt_fraction = st.slider(
                    "Debt fraction for rerun (%)",
                    min_value=0.0,
                    max_value=95.0,
                    value=fixed_finance_project.finance.debt_fraction * 100.0,
                    step=1.0,
                    key="fixed_finance_debt_fraction_pct",
                ) / 100.0
            with r2:
                fixed_finance_project.finance.min_dscr = st.number_input(
                    "Minimum DSCR for rerun",
                    min_value=0.0,
                    max_value=3.0,
                    value=fixed_finance_project.finance.min_dscr,
                    step=0.05,
                    key="fixed_finance_min_dscr",
                )
                fixed_finance_project.finance.target_equity_irr = st.number_input(
                    "Cost of equity / target equity IRR for rerun (%)",
                    min_value=0.0,
                    max_value=40.0,
                    value=fixed_finance_project.finance.target_equity_irr * 100.0,
                    step=0.25,
                    key="fixed_finance_target_equity_irr_pct",
                ) / 100.0
            with r3:
                fixed_finance_project.finance.debt_tenor_years = int(st.number_input(
                    "Debt tenor for rerun",
                    min_value=1,
                    max_value=fixed_finance_project.tender.ppa_years,
                    value=int(fixed_finance_project.finance.debt_tenor_years),
                    step=1,
                    key="fixed_finance_debt_tenor_years",
                ))
                fixed_finance_project.simulation.merchant_price_rs_per_kwh = st.number_input(
                    "Merchant price Yr-1 for rerun (Rs/kWh)",
                    min_value=0.0,
                    max_value=30.0,
                    value=fixed_finance_project.simulation.merchant_price_rs_per_kwh,
                    step=0.05,
                    key="fixed_finance_merchant_price",
                )
                fixed_finance_project.simulation.merchant_escalation = st.number_input(
                    "Merchant escalation for rerun (%)",
                    min_value=0.0,
                    max_value=15.0,
                    value=fixed_finance_project.simulation.merchant_escalation * 100.0,
                    step=0.25,
                    key="fixed_finance_merchant_escalation_pct",
                ) / 100.0

        rerun_tariff, rerun_finance, rerun_status = E.required_tariff(fixed_finance_project, opt_operating)
        base_tariff_finance = None
        if np.isfinite(base_tariff):
            base_tariff_finance = E.financial_model(fixed_finance_project, opt_operating, base_tariff)

        fixed_cap = E.project_capacity_summary(fixed_finance_project)
        c1, c2, c3, c4, c5 = st.columns(5)
        c1.metric("Fixed contracted capacity", f"{fixed_cap['contracted_capacity_mw']:.0f} MW")
        c2.metric("Fixed solar / wind", f"{fixed_cap['solar_ac_mw']:.0f} / {fixed_cap['wind_mw']:.1f} MW")
        c3.metric("Fixed BESS", f"{fixed_cap['bess_power_mw']:.0f} MW / {fixed_cap['bess_usable_poi_mwh_y1']:.0f} MWh")
        c4.metric("Original optimized tariff", "N/A" if not np.isfinite(base_tariff) else f"Rs {base_tariff:.2f}/kWh")
        c5.metric("Cost of equity target", f"{fixed_finance_project.finance.target_equity_irr:.2%}")
        st.caption(
            "This tab does not run the capacity optimizer and does not change dispatch. "
            "It reuses the optimized full-PPA operating table and applies the current sidebar finance/capex inputs."
        )

        if rerun_finance is None:
            st.warning(f"Fixed-size optimized case could not solve tariff under current finance assumptions: {rerun_status.get('reason', 'unknown')}")
        else:
            f1, f2, f3, f4, f5 = st.columns(5)
            tariff_delta = rerun_tariff - base_tariff if np.isfinite(base_tariff) else None
            f1.metric(
                "Required gross tariff",
                f"Rs {rerun_tariff:.2f}/kWh",
                delta=None if tariff_delta is None else f"{tariff_delta:+.2f} vs optimized",
            )
            f2.metric("Equity IRR", f"{rerun_finance.equity_irr:.2%}", delta=f"target {fixed_finance_project.finance.target_equity_irr:.2%}", delta_color="off")
            f3.metric("Project IRR", f"{rerun_finance.project_irr:.2%}")
            f4.metric("Min DSCR", _fmt_dscr(rerun_finance.min_dscr), delta="N/A when debt is 0" if rerun_finance.capex.debt_cr <= 1e-6 else f"target {fixed_finance_project.finance.min_dscr:.2f}x", delta_color="off")
            f5.metric("Total project cost", f"Rs {rerun_finance.capex.total_project_cost_cr:,.0f} cr")

            c1, c2, c3 = st.columns(3)
            c1.metric("Debt", f"Rs {rerun_finance.capex.debt_cr:,.0f} cr")
            c2.metric("Equity", f"Rs {rerun_finance.capex.equity_cr:,.0f} cr")
            c3.metric("Avg DSCR", _fmt_dscr(rerun_finance.avg_dscr))

            if base_tariff_finance is not None:
                st.subheader("Reverse Check At Original Optimized Tariff")
                compare_df = pd.DataFrame([
                    {
                        "case": "Current finance at original optimized tariff",
                        "tariff_rs_per_kwh": base_tariff,
                        "equity_irr": base_tariff_finance.equity_irr,
                        "project_irr": base_tariff_finance.project_irr,
                        "min_dscr": _fmt_dscr(base_tariff_finance.min_dscr),
                        "total_project_cost_cr": base_tariff_finance.capex.total_project_cost_cr,
                    },
                    {
                        "case": "Current finance at re-solved required tariff",
                        "tariff_rs_per_kwh": rerun_tariff,
                        "equity_irr": rerun_finance.equity_irr,
                        "project_irr": rerun_finance.project_irr,
                        "min_dscr": _fmt_dscr(rerun_finance.min_dscr),
                        "total_project_cost_cr": rerun_finance.capex.total_project_cost_cr,
                    },
                ])
                st.dataframe(compare_df, width="stretch", hide_index=True)
                st.caption(
                    "If debt cost rises, the required tariff can rise enough that equity/project IRR also rise. "
                    "The original-tariff row shows the pure finance impact before repricing."
                )

            st.subheader("Capex Build-Up")
            capex_df = pd.DataFrame(
                [{"component": k, "amount_cr": v} for k, v in rerun_finance.capex.components.items()]
            )
            capex_df.loc[len(capex_df)] = {"component": "IDC", "amount_cr": rerun_finance.capex.idc_cr}
            capex_df.loc[len(capex_df)] = {"component": "Total project cost", "amount_cr": rerun_finance.capex.total_project_cost_cr}
            st.dataframe(capex_df, width="stretch", hide_index=True)

            st.subheader("Full-PPA Financial Model")
            st.dataframe(rerun_finance.table, width="stretch", hide_index=True)

            fig = go.Figure()
            fig.add_bar(x=rerun_finance.table["year"], y=rerun_finance.table["revenue_net_cr"], name="Net revenue")
            fig.add_bar(x=rerun_finance.table["year"], y=rerun_finance.table["ebitda_cr"], name="EBITDA")
            fig.add_scatter(x=rerun_finance.table["year"], y=rerun_finance.table["dscr"], mode="lines+markers", name="DSCR", yaxis="y2")
            fig.update_layout(
                height=420,
                margin=dict(l=20, r=20, t=20, b=20),
                xaxis_title="PPA year",
                yaxis_title="Rs cr",
                yaxis2=dict(title="DSCR", overlaying="y", side="right"),
                barmode="group",
            )
            st.plotly_chart(fig, width="stretch", key="optimized_finance_chart")

with custom_tab:
    st.subheader("Custom Sidebar Case")
    st.caption("This tab evaluates the capacities, CUFs and finance assumptions currently selected in the sidebar.")
    k1, k2, k3, k4, k5 = st.columns(5)
    k1.metric("Contracted capacity", f"{cap_summary['contracted_capacity_mw']:.0f} MW")
    k2.metric("Solar / Wind", f"{cap_summary['solar_ac_mw']:.0f} / {cap_summary['wind_mw']:.1f} MW")
    k3.metric("BESS", f"{cap_summary['bess_power_mw']:.0f} MW / {cap_summary['bess_usable_poi_mwh_y1']:.0f} MWh")
    k4.metric("Min peak availability", f"{status['min_monthly_peak_availability']:.1%}")
    k5.metric("Custom required tariff", "Infeasible" if not np.isfinite(result["tariff"]) else f"Rs {result['tariff']:.2f}/kWh")

    if not np.isfinite(result["tariff"]):
        st.warning(f"Custom case is infeasible under selected hard constraints: {status.get('reason', 'unknown')}. Adjust sidebar capacities/CUFs, turn off hard compliance, or allow external green support.")

    st.subheader("Custom RfS Compliance")
    st.dataframe(E.compliance_checklist(project, op), width="stretch")
    st.subheader("Monthly peak availability - first simulated year")
    monthly = first.monthly.copy()
    monthly["month_name"] = [MONTH_NAMES[i - 1] for i in monthly["month"]]
    fig = go.Figure()
    fig.add_bar(x=monthly["month_name"], y=monthly["peak_availability"], name="Availability")
    fig.add_scatter(x=monthly["month_name"], y=[project.tender.peak_availability_floor] * 12, mode="lines", name="RfS floor")
    fig.update_yaxes(tickformat=".0%", range=[0, 1.05])
    fig.update_layout(height=360, margin=dict(l=20, r=20, t=20, b=20))
    st.plotly_chart(fig, width="stretch", key="custom_monthly_peak_chart")
    st.dataframe(monthly[["month_name", "peak_obligation_mwh", "peak_delivered_mwh", "external_green_mwh", "peak_shortfall_mwh", "peak_availability", "compliant"]], width="stretch")
    st.subheader("Custom operating summary")
    st.dataframe(op, width="stretch")

    st.subheader("Custom Finance")
    if fin is None:
        st.info("Custom finance table is unavailable because this custom case is infeasible or tariff could not be solved.")
        if st.button("Price custom case with penalties anyway at Rs 5.00/kWh"):
            trial = E.financial_model(project, op, 5.0)
            st.dataframe(trial.table, width="stretch")
    else:
        c1, c2, c3, c4 = st.columns(4)
        c1.metric("Equity IRR", f"{fin.equity_irr:.2%}")
        c2.metric("Project IRR", f"{fin.project_irr:.2%}")
        c3.metric("Min DSCR", f"{fin.min_dscr:.2f}x")
        c4.metric("TPC", f"Rs {fin.capex.total_project_cost_cr:,.0f} cr")
        st.dataframe(fin.table, width="stretch")

with project_tab:
    c1, c2 = st.columns(2)
    with c1:
        st.subheader("Capacity summary")
        st.dataframe(pd.DataFrame([cap_summary]).T.rename(columns={0: "value"}), width="stretch")
        st.subheader("Nodes / interconnection")
        st.dataframe(pd.DataFrame([E.asdict(n) for n in project.nodes]), width="stretch")
    with c2:
        st.subheader("Generators")
        st.dataframe(pd.DataFrame([E.asdict(g) for g in project.generators]), width="stretch")
        st.subheader("BESS")
        bess_df = pd.DataFrame([E.asdict(b) for b in project.bess])
        show_cols = ["name", "node", "power_mw", "energy_mwh", "usable_mwh_at_poi", "rte", "augmentation_years", "notes"]
        st.dataframe(bess_df[show_cols], width="stretch")

with dispatch_tab:
    st.subheader("First-year hourly dispatch")
    dispatch_year = st.slider("Display year", 1, project.tender.ppa_years, 1)
    if dispatch_year == 1:
        dres = first
    else:
        dres = _dispatch_cached(project_json, dispatch_year, wind_custom_cf)
    hourly = dres.hourly.copy() if dres.hourly is not None else pd.DataFrame()
    start_day = st.slider("Start day", 1, 358, 1)
    window = hourly.iloc[(start_day - 1) * 24:(start_day - 1) * 24 + 24 * 7].copy()
    window["t"] = np.arange(len(window))
    fig = go.Figure()
    fig.add_scatter(x=window["t"], y=window["total_re_mw"], mode="lines", name="RE generation")
    fig.add_scatter(x=window["t"], y=window["ppa_mwh"], mode="lines", name="PPA scheduled")
    fig.add_scatter(x=window["t"], y=window["bess_discharge_mwh"], mode="lines", name="BESS discharge")
    fig.add_scatter(x=window["t"], y=window["bess_charge_mwh"], mode="lines", name="BESS charge")
    fig.add_scatter(x=window["t"], y=window["soc_mwh"], mode="lines", name="SOC")
    fig.update_layout(height=420, margin=dict(l=20, r=20, t=20, b=20), xaxis_title="Hour in selected week", yaxis_title="MW / MWh")
    st.plotly_chart(fig, width="stretch", key=f"dispatch_week_chart_year_{dispatch_year}_day_{start_day}")
    st.dataframe(window[["month", "day", "hour", "total_re_mw", "peak_target_mwh", "ppa_peak_mwh", "ppa_nonpeak_mwh", "bess_charge_mwh", "bess_discharge_mwh", "merchant_mwh", "spill_mwh", "soc_mwh"]], width="stretch")


with export_tab:
    st.subheader("Download model artifacts")
    config_bytes = json.dumps(E.project_to_dict(project), indent=2).encode("utf-8")
    st.download_button("Download current project JSON", config_bytes, file_name="current_fdre_project_config.json", mime="application/json")
    st.download_button("Download displayed operating summary CSV", op.to_csv(index=False).encode("utf-8"), file_name="fdre_operating_summary_displayed.csv", mime="text/csv")
    if first.hourly is not None:
        st.download_button("Download first-year hourly dispatch CSV", first.hourly.to_csv(index=False).encode("utf-8"), file_name="fdre_hourly_dispatch_year1.csv", mime="text/csv")
    if fin is not None:
        st.download_button("Download finance table CSV", fin.table.to_csv(index=False).encode("utf-8"), file_name="fdre_finance_table.csv", mime="text/csv")

    st.divider()
    st.subheader("Full PPA-term dispatch download")
    full_rows = int(project.tender.ppa_years) * E.HOURS_PER_YEAR
    st.caption(
        f"Builds {project.tender.ppa_years} PPA years of hourly dispatch "
        f"({full_rows:,} hourly rows), plus yearly and monthly compliance summaries."
    )

    if st.button("Prepare full hourly + yearly PPA dispatch files", type="primary"):
        with st.spinner("Building full PPA-term dispatch tables and ZIP export..."):
            tables = _full_term_dispatch_cached(project_json, wind_custom_cf)
            annual_csv = tables["annual"].to_csv(index=False).encode("utf-8")
            monthly_csv = tables["monthly"].to_csv(index=False).encode("utf-8")
            hourly_csv = tables["hourly"].to_csv(index=False).encode("utf-8")
            zip_bytes = _make_dispatch_zip(project_json, annual_csv, monthly_csv, hourly_csv)
            st.session_state["full_dispatch_export"] = {
                "project_key": project_json,
                "hourly_rows": int(len(tables["hourly"])),
                "annual_rows": int(len(tables["annual"])),
                "monthly_rows": int(len(tables["monthly"])),
                "hourly_csv": hourly_csv,
                "annual_csv": annual_csv,
                "monthly_csv": monthly_csv,
                "zip_bytes": zip_bytes,
            }

    export = st.session_state.get("full_dispatch_export")
    if export and export.get("project_key") == project_json:
        c1, c2, c3 = st.columns(3)
        c1.metric("Hourly rows", f"{export['hourly_rows']:,}")
        c2.metric("Yearly rows", f"{export['annual_rows']:,}")
        c3.metric("Monthly rows", f"{export['monthly_rows']:,}")
        st.download_button(
            "Download full PPA dispatch ZIP",
            export["zip_bytes"],
            file_name="fdre_full_ppa_dispatch_export.zip",
            mime="application/zip",
        )
        st.download_button(
            "Download hourly dispatch CSV",
            export["hourly_csv"],
            file_name="fdre_hourly_dispatch_ppa_term.csv",
            mime="text/csv",
        )
        st.download_button(
            "Download yearly dispatch summary CSV",
            export["annual_csv"],
            file_name="fdre_yearly_dispatch_ppa_term.csv",
            mime="text/csv",
        )
        st.download_button(
            "Download monthly compliance CSV",
            export["monthly_csv"],
            file_name="fdre_monthly_compliance_ppa_term.csv",
            mime="text/csv",
        )
    else:
        st.info("Prepare the full dispatch files after finalizing the sidebar assumptions. Any configuration change requires a fresh export.")

    st.code("streamlit run app.py", language="bash")


# ---------------------------------------------------------------------------
# PVsyst Report tab

with pvsyst_tab:
    st.subheader("PVsyst report ingestion")
    st.caption(
        "Upload up to three PVsyst simulation reports. Each report becomes a solar site with its own "
        "P50/P75/P90 CUF table, model input switch, EYA switch and optimizer sizing bound."
    )

    pvu1, pvu2 = st.columns([2, 1])
    uploaded_pvsyst = pvu1.file_uploader("Upload PVsyst PDFs (max 3)", type=["pdf"],
                                         accept_multiple_files=True, key="pvsyst_pdf_upload_multi")
    parse_uploaded = pvu1.button("Parse uploaded PVsyst reports", disabled=not uploaded_pvsyst)
    sample_paths = [p for p in PVSYST_SAMPLE_PATHS if os.path.exists(p)]
    parse_sample = pvu2.button("Load sample PVsyst reports from Downloads", disabled=not sample_paths)
    if not sample_paths:
        pvu2.caption("Local sample reports not found in Downloads.")

    def store_pvsyst_reports(files: list[tuple[str, bytes]], success_label: str):
        parsed = []
        errors = []
        for name, payload in files[:MAX_PVSYST_SITES]:
            try:
                parsed.append({"report": YA.parse_pvsyst_pdf_bytes(payload, source_name=name)})
            except Exception as exc:
                errors.append(f"{name}: {exc}")
        if parsed:
            st.session_state["pvsyst_reports"] = parsed
            st.session_state["pvsyst_report"] = parsed[0]["report"]
            st.success(f"{success_label}: parsed {len(parsed)} PVsyst report(s).")
        for err in errors:
            st.error(f"Could not parse PVsyst report {err}")

    if parse_uploaded and uploaded_pvsyst:
        store_pvsyst_reports([(f.name, f.getvalue()) for f in uploaded_pvsyst], "Uploaded reports")

    if parse_sample:
        sample_files = []
        for path in sample_paths[:MAX_PVSYST_SITES]:
            with open(path, "rb") as fh:
                sample_files.append((os.path.basename(path), fh.read()))
        store_pvsyst_reports(sample_files, "Downloads samples")

    slots = _pvsyst_slots()
    if slots:
        summary_rows = []
        solar_targets = [g.name for g in project.generators if g.technology.lower() == "solar"]
        node_options = [n.name for n in project.nodes]
        for idx, slot in enumerate(slots):
            report = slot["report"]
            default_target = _pvsyst_slot_target(idx, project)
            target_options = list(dict.fromkeys(solar_targets + [default_target, f"PVsyst_Site_{idx + 1}_Solar"]))
            if f"pvsyst_site_{idx}_target" not in st.session_state:
                st.session_state[f"pvsyst_site_{idx}_target"] = default_target
            if f"pvsyst_site_{idx}_node" not in st.session_state:
                st.session_state[f"pvsyst_site_{idx}_node"] = _pvsyst_slot_node(idx, project)
            if f"pvsyst_site_{idx}_level" not in st.session_state:
                st.session_state[f"pvsyst_site_{idx}_level"] = "P50"
            if f"pvsyst_site_{idx}_uncertainty" not in st.session_state:
                st.session_state[f"pvsyst_site_{idx}_uncertainty"] = 4.87

            with st.expander(f"Solar site {idx + 1}: {_pvsyst_site_display(slot, idx)}", expanded=(idx == 0)):
                e_grid_mwh = float(report.get("p50_mwh_y1") or 0.0)
                ac_mw = float(report.get("ac_mw") or 0.0)
                dc_mwp = float(report.get("dc_mwp") or 0.0)
                ac_cuf = 100.0 * float(report.get("ac_cuf") or 0.0)
                dc_cuf = 100.0 * float(report.get("dc_cuf") or 0.0)
                k1, k2, k3, k4, k5 = st.columns(5)
                k1.metric("P50 E_Grid", f"{e_grid_mwh:,.0f} MWh")
                k2.metric("AC CUF", f"{ac_cuf:.2f}%")
                k3.metric("DC CUF", f"{dc_cuf:.2f}%")
                k4.metric("Specific yield", f"{float(report.get('specific_yield_kwh_per_kwp') or 0):,.0f} kWh/kWp")
                k5.metric("PR", f"{float(report.get('pr_pct') or 0):.2f}%")

                c1, c2, c3, c4, c5 = st.columns(5)
                c1.number_input("Solar uncertainty (%)", 0.0, 20.0,
                                float(st.session_state[f"pvsyst_site_{idx}_uncertainty"]), 0.1,
                                key=f"pvsyst_site_{idx}_uncertainty")
                c2.selectbox("P-level for model/optimizer", ["P50", "P75", "P90"],
                             key=f"pvsyst_site_{idx}_level")
                c3.selectbox("Target solar generator", target_options,
                             key=f"pvsyst_site_{idx}_target")
                c4.selectbox("Node for new site", node_options or [""],
                             key=f"pvsyst_site_{idx}_node")
                c5.checkbox("Use in model/optimizer", value=st.session_state.get(f"pvsyst_site_model_enabled_{idx}", False),
                            key=f"pvsyst_site_model_enabled_{idx}")
                st.checkbox("Use in EYA solar assessment", value=st.session_state.get(f"pvsyst_site_eya_enabled_{idx}", False),
                            key=f"pvsyst_site_eya_enabled_{idx}")

                probability = YA.pvsyst_probability_table(
                    report, uncertainty_pct=float(st.session_state[f"pvsyst_site_{idx}_uncertainty"]),
                    levels=("P50", "P75", "P90"))
                st.markdown("**PVsyst probability levels**")
                st.dataframe(probability.round({
                    "Factor": 4, "Generation Y1 (MWh)": 0, "Specific yield (kWh/kWp)": 0,
                    "DC CUF %": 2, "AC CUF %": 2,
                }), hide_index=True, width="stretch")

                st.dataframe(pd.DataFrame([{
                    "Source": report.get("source_name"),
                    "Project": report.get("project"),
                    "Variant": report.get("variant"),
                    "Site": report.get("site"),
                    "Latitude": report.get("latitude"),
                    "Longitude": report.get("longitude"),
                    "Altitude m": report.get("altitude_m"),
                    "Weather": report.get("weather_source"),
                    "DC MWp": dc_mwp,
                    "AC MW": ac_mw,
                    "DC:AC": report.get("dc_ac"),
                    "GHI kWh/m2": report.get("ghi_kwh_m2"),
                    "Ambient C": report.get("ambient_temp_c"),
                    "Tilt": report.get("tilt_deg"),
                    "Azimuth": report.get("azimuth_deg"),
                }]), hide_index=True, width="stretch")

                metrics = YA.pvsyst_level_metrics(
                    report, level=st.session_state[f"pvsyst_site_{idx}_level"],
                    uncertainty_pct=float(st.session_state[f"pvsyst_site_{idx}_uncertainty"]))
                summary_rows.append({
                    "Slot": idx + 1,
                    "Source": report.get("source_name"),
                    "Target": st.session_state[f"pvsyst_site_{idx}_target"],
                    "Use model": bool(st.session_state.get(f"pvsyst_site_model_enabled_{idx}", False)),
                    "Use EYA": bool(st.session_state.get(f"pvsyst_site_eya_enabled_{idx}", False)),
                    "P-level": st.session_state[f"pvsyst_site_{idx}_level"],
                    "AC MW": ac_mw,
                    "DC MWp": dc_mwp,
                    "Selected Y1 MWh": metrics["mwh_y1"],
                    "Selected AC CUF %": 100 * metrics["ac_cuf"],
                })

                monthly = pd.DataFrame(report.get("monthly") or [])
                if not monthly.empty:
                    with st.expander("Monthly PVsyst balances"):
                        st.dataframe(monthly, hide_index=True, width="stretch", height=420)
                        st.download_button("Download monthly CSV", monthly.to_csv(index=False).encode(),
                                           f"pvsyst_site_{idx + 1}_monthly.csv", "text/csv",
                                           key=f"pvsyst_download_monthly_{idx}")

        st.markdown("**PVsyst sites applied to model/EYA**")
        st.dataframe(pd.DataFrame(summary_rows).round({
            "AC MW": 2, "DC MWp": 2, "Selected Y1 MWh": 0, "Selected AC CUF %": 2,
        }), hide_index=True, width="stretch")
    else:
        st.info("Upload up to three PVsyst PDFs, or load the supplied NHPC Bikaner reports from Downloads.")


# ---------------------------------------------------------------------------
# Wind EYA tab

with wind_eya_tab:
    st.subheader("Wind Energy Yield Assessment")
    status_wpl = WYA.windpowerlib_status()
    st.caption(
        "Enterprise-style wind EYA page with scenario inputs, turbine configuration, loss waterfall, "
        "8760 profile, uncertainty/P-levels and bankable-report exports. "
        f"windpowerlib status: {status_wpl['message']}"
    )

    with st.expander("Wind generation CSV input for model and optimizer", expanded=True):
        st.caption(
            "Use the hourly 3.15 MW turbine generation file as the wind yield basis. "
            "The selected P-level is normalized to capacity factor and multiplied by optimized wind MW."
        )
        wg1, wg2, wg3 = st.columns([1.2, 1, 1])
        uploaded_wind = wg1.file_uploader(
            "Upload wind turbine generation CSV",
            type=["csv"],
            key="wind_generation_csv_upload",
        )
        rated_wtg_mw = wg2.number_input("WTG rating for CSV (MW)", 0.5, 10.0, 3.15, 0.05)
        if wg3.button("Load Bikaner wind CSV", key="load_bikaner_wind_generation_csv"):
            try:
                st.session_state["wind_generation_report"] = WYA.parse_wind_generation_csv(
                    WIND_GENERATION_SAMPLE_PATH,
                    rated_power_mw=float(rated_wtg_mw),
                )
                st.session_state["wind_generation_upload_key"] = f"sample:{WIND_GENERATION_SAMPLE_PATH}:{rated_wtg_mw}"
                st.rerun()
            except Exception as exc:
                st.error(f"Could not load sample wind CSV: {exc}")

        if uploaded_wind is not None:
            upload_key = f"{uploaded_wind.name}:{uploaded_wind.size}:{rated_wtg_mw}"
            if st.session_state.get("wind_generation_upload_key") != upload_key:
                try:
                    st.session_state["wind_generation_report"] = WYA.parse_wind_generation_csv_bytes(
                        uploaded_wind.getvalue(),
                        source_name=uploaded_wind.name,
                        rated_power_mw=float(rated_wtg_mw),
                    )
                    st.session_state["wind_generation_upload_key"] = upload_key
                    st.rerun()
                except Exception as exc:
                    st.error(f"Could not parse uploaded wind CSV: {exc}")

        wind_report = st.session_state.get("wind_generation_report")
        if wind_report:
            level_options = ["P50", "P75", "P90"]
            current_level = st.session_state.get("wind_generation_level", "P50")
            selected_level = st.selectbox(
                "P-level used for FDRE dispatch and optimizer",
                level_options,
                index=level_options.index(current_level) if current_level in level_options else 0,
                key="wind_generation_level",
            )
            use_wind_profile = st.checkbox(
                "Use selected wind generation profile in model and optimizer",
                value=bool(st.session_state.get("wind_generation_use_in_model", False)),
                key="wind_generation_use_in_model",
            )
            summary_df = wind_report["summary"].copy()
            st.dataframe(summary_df.round(2), width="stretch", hide_index=True)
            selected = summary_df.set_index("P-level").loc[selected_level]
            k1, k2, k3, k4 = st.columns(4)
            k1.metric("Selected case", selected_level)
            k2.metric("WTG AEP", f"{selected['Per-turbine AEP (GWh)']:.2f} GWh")
            k3.metric("WTG CF", f"{selected['Capacity factor %']:.2f}%")
            k4.metric("Rows", f"{len(wind_report['hourly']):,}")
            if use_wind_profile:
                st.success("This wind profile will drive current dispatch, optimizer sizing, finance reruns and exports.")
            else:
                st.info("Profile is loaded for review. Turn on the checkbox to apply it to the model and optimizer.")
            st.dataframe(wind_report["monthly"].round(2), width="stretch", hide_index=True)
        else:
            st.info("Load the Bikaner wind CSV or upload a turbine-generation CSV to use hourly wind yield in the model.")

    if "wind_eya_scenarios" not in st.session_state:
        st.session_state["wind_eya_scenarios"] = ["Base", "Optimistic", "Conservative"]
    scenario_names = st.session_state["wind_eya_scenarios"]

    top1, top2, top3, top4 = st.columns(4)
    scenario_name = top1.selectbox("Scenario", scenario_names)
    assessment_name = top2.text_input("Assessment name", f"Wind EYA - {scenario_name}")
    project_version_w = top3.text_input("Project version", "v1")
    approval_status = top4.selectbox("Approval status", ["Draft", "In Review", "Approved", "Rejected"])
    meta1, meta2, meta3, meta4 = st.columns(4)
    assessment_date = meta1.date_input("Assessment date")
    engineer = meta2.text_input("Engineer", "")
    reviewer = meta3.text_input("Reviewer", "")
    methodology = meta4.selectbox("Calculation methodology", [
        "Weibull resource + power curve + sequential loss model",
        "windpowerlib ModelChain (when installed) + loss model",
    ])

    with st.expander("1-4. Resource, terrain, turbine and layout inputs", expanded=True):
        r1, r2, r3, r4 = st.columns(4)
        mean_ws = r1.number_input("Long-term mean wind speed (m/s)", 3.0, 15.0, 7.35, 0.05)
        weibull_a = r2.number_input("Weibull A", 3.0, 18.0, 8.25, 0.05)
        weibull_k = r3.number_input("Weibull K", 1.0, 5.0, 2.05, 0.05)
        turbulence = r4.number_input("Turbulence intensity", 0.01, 0.40, 0.12, 0.01)
        r5, r6, r7, r8 = st.columns(4)
        air_density = r5.number_input("Air density (kg/m3)", 0.9, 1.35, 1.18, 0.01)
        shear = r6.number_input("Wind shear exponent", 0.0, 0.5, 0.16, 0.01)
        ref_height = r7.number_input("Reference height (m)", 40.0, 180.0, 120.0, 5.0)
        terrain_complexity = r8.selectbox("Terrain complexity", ["Simple", "Moderate", "Complex"])

        t1, t2, t3, t4, t5 = st.columns(5)
        roughness = t1.number_input("Roughness class", 0.0, 4.0, 1.5, 0.1)
        elevation = t2.number_input("Elevation (m)", 0.0, 3000.0, 180.0, 10.0)
        slope = t3.number_input("Slope (deg)", 0.0, 45.0, 2.0, 0.5)
        iec_terrain = t4.selectbox("IEC terrain category", ["I", "II", "III", "IV"])
        iec_class = t5.selectbox("IEC turbine class", ["I", "II", "III", "S"])

        u1, u2, u3, u4 = st.columns(4)
        manufacturer = u1.text_input("Manufacturer", "Suzlon")
        model = u2.text_input("Model", "S144")
        rated_power = u3.number_input("Rated power (MW)", 0.5, 12.0, 3.15, 0.05)
        rotor = u4.number_input("Rotor diameter (m)", 50.0, 250.0, 144.0, 1.0)
        u5, u6, u7, u8 = st.columns(4)
        hub = u5.number_input("Hub height (m)", 50.0, 200.0, 140.0, 5.0)
        cut_in = u6.number_input("Cut-in speed (m/s)", 1.0, 6.0, 3.0, 0.1)
        rated_speed = u7.number_input("Rated speed (m/s)", 7.0, 16.0, 10.5, 0.1)
        cut_out = u8.number_input("Cut-out speed (m/s)", 18.0, 35.0, 25.0, 0.5)
        l1, l2, l3, l4 = st.columns(4)
        n_turbines = int(l1.number_input("Number of turbines", 1, 200, 16, 1))
        alignment = l2.number_input("Prevailing wind alignment (deg)", 0.0, 360.0, 240.0, 5.0)
        wake_groups = l3.text_input("Wake groups", "Single row / moderate wake")
        layout_note = l4.text_input("Constraint layers", "Boundary, roads, exclusions")

        curve_default = WYA.default_power_curve(rated_power, cut_in, rated_speed, cut_out)
        power_curve = st.data_editor(curve_default, hide_index=True, width="stretch",
                                     key=f"wind_power_curve_{scenario_name}_{rated_power}_{cut_in}_{rated_speed}_{cut_out}")
        layout_df = st.data_editor(WYA.default_layout(n_turbines), hide_index=True, width="stretch",
                                   key=f"wind_layout_{scenario_name}_{n_turbines}")

    with st.expander("5-6. Editable loss assessment and uncertainty", expanded=True):
        c1, c2 = st.columns(2)
        loss_df = c1.data_editor(
            pd.DataFrame({"Loss item": list(WYA.DEFAULT_LOSSES.keys()), "Loss %": list(WYA.DEFAULT_LOSSES.values())}),
            hide_index=True, width="stretch", key=f"wind_loss_editor_{scenario_name}")
        unc_df = c2.data_editor(
            pd.DataFrame({"Uncertainty": list(WYA.DEFAULT_UNCERTAINTIES.keys()), "% on AEP": list(WYA.DEFAULT_UNCERTAINTIES.values())}),
            hide_index=True, width="stretch", key=f"wind_unc_editor_{scenario_name}")

    inputs_w = WYA.WindAssessmentInputs(
        assessment_name=assessment_name,
        project_version=project_version_w,
        scenario_name=scenario_name,
        engineer=engineer,
        reviewer=reviewer,
        approval_status=approval_status,
        methodology=methodology,
        mean_wind_speed=float(mean_ws),
        weibull_a=float(weibull_a),
        weibull_k=float(weibull_k),
        turbulence_intensity=float(turbulence),
        air_density=float(air_density),
        shear_exponent=float(shear),
        reference_height_m=float(ref_height),
        terrain_complexity=terrain_complexity,
        roughness_class=float(roughness),
        elevation_m=float(elevation),
        slope_deg=float(slope),
        iec_terrain_category=iec_terrain,
        manufacturer=manufacturer,
        model=model,
        rated_power_mw=float(rated_power),
        rotor_diameter_m=float(rotor),
        hub_height_m=float(hub),
        iec_class=iec_class,
        cut_in_speed=float(cut_in),
        rated_speed=float(rated_speed),
        cut_out_speed=float(cut_out),
        number_of_turbines=int(n_turbines),
        prevailing_alignment_deg=float(alignment),
        wake_groups=wake_groups,
    )
    losses_w = dict(zip(loss_df["Loss item"], loss_df["Loss %"].astype(float)))
    unc_w = dict(zip(unc_df["Uncertainty"], unc_df["% on AEP"].astype(float)))
    wind_result = WYA.run_wind_eya(inputs_w, losses_w, unc_w, power_curve, layout_df)

    if st.button("Save wind scenario result", key="save_wind_eya_scenario"):
        st.session_state.setdefault("wind_eya_results", {})[scenario_name] = wind_result
        st.success(f"Saved scenario: {scenario_name}")

    ov = wind_result["overview"]
    m1, m2, m3, m4, m5 = st.columns(5)
    m1.metric("Gross AEP", f"{ov['gross_aep_mwh']/1000:.1f} GWh")
    m2.metric("Net AEP", f"{ov['net_aep_mwh']/1000:.1f} GWh")
    m3.metric("Net CF", f"{ov['net_cf_pct']:.2f}%")
    m4.metric("Specific yield", f"{ov['net_specific_yield_mwh_per_mw']:.0f} MWh/MW")
    m5.metric("Total uncertainty", f"{ov['total_uncertainty_pct']:.2f}%")

    st.markdown("### Gross and net production")
    g1, g2 = st.columns(2)
    fig_month = go.Figure()
    fig_month.add_bar(x=wind_result["monthly"]["Month"], y=wind_result["monthly"]["Gross"], name="Gross")
    fig_month.add_bar(x=wind_result["monthly"]["Month"], y=wind_result["monthly"]["Net"], name="Net")
    fig_month.update_layout(height=340, barmode="group", yaxis_title="MWh", margin=dict(l=10, r=10, t=10, b=10))
    g1.plotly_chart(fig_month, width="stretch", key="wind_eya_monthly_chart")
    fig_duration = go.Figure()
    duration = np.sort(wind_result["hourly"]["Net Energy (MWh)"].to_numpy())[::-1]
    fig_duration.add_scatter(x=np.arange(1, len(duration) + 1), y=duration, name="Net hourly MWh")
    fig_duration.update_layout(height=340, xaxis_title="Hour rank", yaxis_title="MWh", margin=dict(l=10, r=10, t=10, b=10))
    g2.plotly_chart(fig_duration, width="stretch", key="wind_eya_duration_chart")

    st.markdown("### Loss waterfall")
    wf = wind_result["waterfall"]
    fig_loss = go.Figure(go.Waterfall(
        x=wf["Stage"],
        measure=["absolute"] + ["relative"] * (len(wf) - 2) + ["total"],
        y=[wf.iloc[0]["Energy (MWh)"]] + [-v for v in wf.iloc[1:-1]["Loss MWh"]] + [wf.iloc[-1]["Energy (MWh)"]],
    ))
    fig_loss.update_layout(height=420, yaxis_title="MWh", margin=dict(l=10, r=10, t=10, b=10),
                           xaxis=dict(tickfont=dict(size=9)))
    st.plotly_chart(fig_loss, width="stretch", key="wind_eya_loss_waterfall")

    tabs_wind = st.tabs(["Net Energy", "Monthly Energy", "8760 Profile", "Uncertainty", "Layout/GIS", "windpowerlib"])
    with tabs_wind[0]:
        st.dataframe(pd.DataFrame([{
            "Mean wind speed at hub (m/s)": ov["mean_wind_speed_hub"],
            "Gross AEP (MWh)": ov["gross_aep_mwh"],
            "Gross CF %": ov["gross_cf_pct"],
            "Net AEP (MWh)": ov["net_aep_mwh"],
            "Net CF %": ov["net_cf_pct"],
            "Export energy (MWh)": ov["export_energy_mwh"],
            "Internal consumption (MWh)": ov["internal_consumption_mwh"],
        }]).round(2), hide_index=True, width="stretch")
        st.dataframe(wf.round(2), hide_index=True, width="stretch", height=420)
    with tabs_wind[1]:
        st.dataframe(wind_result["monthly"].round(2), hide_index=True, width="stretch")
    with tabs_wind[2]:
        hourly_export = wind_result["hourly"].round(4)
        st.dataframe(hourly_export.head(500), hide_index=True, width="stretch", height=420)
        st.download_button("Download 8760 CSV", hourly_export.to_csv(index=False).encode(),
                           "wind_eya_8760_profile.csv", "text/csv", key="wind_eya_download_8760")
    with tabs_wind[3]:
        st.dataframe(pd.DataFrame(list(unc_w.items()), columns=["Uncertainty", "% on AEP"]),
                     hide_index=True, width="stretch")
        st.dataframe(wind_result["p_levels"].round(2), hide_index=True, width="stretch")
    with tabs_wind[4]:
        st.caption(f"Constraint layers: {layout_note}")
        st.dataframe(layout_df, hide_index=True, width="stretch")
        fig_layout = go.Figure()
        fig_layout.add_scatter(x=layout_df["X (m)"], y=layout_df["Y (m)"], mode="markers+text",
                               text=layout_df["Turbine"], textposition="top center",
                               marker=dict(size=12, color=np.arange(len(layout_df)), colorscale="Viridis"))
        fig_layout.update_layout(height=420, xaxis_title="X (m)", yaxis_title="Y (m)",
                                 margin=dict(l=10, r=10, t=10, b=10))
        st.plotly_chart(fig_layout, width="stretch", key="wind_eya_layout_chart")
    with tabs_wind[5]:
        st.markdown(
            "Use `windpowerlib` as the physics engine for weather-height correction, turbine-library "
            "lookup, manufacturer power curves, ModelChain simulation, and wind farm or cluster model "
            "chains. The app currently keeps a deterministic fallback model so it works even when the "
            "package is not installed."
        )
        st.code(
            """pip install windpowerlib

from windpowerlib import ModelChain, WindTurbine, create_power_curve

turbine = WindTurbine(
    nominal_power=3150000,
    hub_height=140,
    power_curve=create_power_curve(wind_speed=curve["wind"], power=curve["power_w"])
)

mc = ModelChain(turbine).run_model(weather_dataframe)
power_output_w = mc.power_output
""",
            language="python",
        )

    saved = st.session_state.get("wind_eya_results", {})
    if saved:
        st.markdown("### Scenario comparison")
        st.dataframe(WYA.scenario_comparison(saved).round(2), hide_index=True, width="stretch")


# ---------------------------------------------------------------------------
# EYA Report tab

@st.cache_data(show_spinner=False)
def _eya_hybrid_cached(project_json: str, levels: tuple, years: tuple, horizon: int,
                       sw: float, ss: float, tl: float):
    pj = E.project_from_dict(json.loads(project_json))
    return YA.hybrid_eya(pj, levels=levels, years=years, horizon=horizon,
                         sigma_wind_pct=sw, sigma_solar_pct=ss, trans_loss_pct=tl)


with eya_tab:
    st.subheader("Energy Yield Assessment (EYA) — online report")
    st.caption(
        "Consultant-style hybrid EYA: wind and solar resource assessments with loss waterfalls and "
        "uncertainty (RSS), BESS SoH/RTE schedules, and a P-level hybrid assessment run on this app's "
        "hourly dispatch engine. Defaults are calibrated to the RE4C 'Hybrid EYA Report — 250 MW NHPC "
        "FDRE' (50.4 MW wind + 300 MW solar + 740 MWh BESS, Bikaner/Jaisalmer)."
    )

    solar_site_defaults = [dict(s) for s in YA.SOLAR_SITES_DEFAULTS]
    solar_editor_suffix = "default"
    eya_pvsyst_inputs = _pvsyst_active_inputs(project, "pvsyst_site_eya_enabled")
    if eya_pvsyst_inputs:
        suffix_parts = []
        applied_labels = []
        for item in eya_pvsyst_inputs:
            target = item["target"]
            safe_target = E._safe_name(target).lower()
            if "iii" in safe_target:
                eya_target = "Bikaner III"
            elif "ii" in safe_target:
                eya_target = "Bikaner II"
            else:
                eya_target = target
            solar_site_defaults = YA.apply_pvsyst_to_solar_sites(
                solar_site_defaults, item["report"], eya_target,
                uncertainty_pct=item["uncertainty"], level=item["level"])
            suffix_parts.append(f"{str(item['report'].get('fingerprint', 'pvsyst'))[:8]}_{E._safe_name(eya_target)}_{item['level']}")
            applied_labels.append(
                f"{item['report'].get('source_name') or item['report'].get('project')} -> {eya_target} at {item['level']}"
            )
        solar_editor_suffix = "_".join(suffix_parts)
        st.success("PVsyst EYA inputs applied: " + "; ".join(applied_labels) + ".")
    elif st.session_state.get("eya_pvsyst_enabled") and st.session_state.get("pvsyst_report"):
        pvsyst_for_eya = st.session_state.get("pvsyst_report")
        pvsyst_target = st.session_state.get("eya_pvsyst_target", "Bikaner II")
        pvsyst_level = st.session_state.get("pvsyst_model_level", "P50")
        pvsyst_uncertainty = float(st.session_state.get("pvsyst_uncertainty_pct", 4.87))
        solar_site_defaults = YA.apply_pvsyst_to_solar_sites(
            YA.SOLAR_SITES_DEFAULTS, pvsyst_for_eya, pvsyst_target,
            uncertainty_pct=pvsyst_uncertainty, level=pvsyst_level)
        solar_editor_suffix = f"{str(pvsyst_for_eya.get('fingerprint', 'pvsyst'))[:10]}_{E._safe_name(pvsyst_target)}_{pvsyst_level}"
        st.success(
            f"PVsyst report '{pvsyst_for_eya.get('source_name') or pvsyst_for_eya.get('project')}' "
            f"is applied to {pvsyst_target} solar input at {pvsyst_level}."
        )

    with st.expander("EYA inputs", expanded=False):
        c1, c2, c3, c4 = st.columns(4)
        eya_src = c1.radio("Configuration", ["EYA report portfolio (250 MW)", "Current sidebar project"],
                           help="The report portfolio uses net P50 CUFs back-calculated from the EYA "
                                "(wind 40.38%, solar 31.07/31.46%), evening peak 18:00–22:00, CC 250 MW.")
        levels_sel = c2.multiselect("Probability levels", list(YA.Z_LEVELS.keys()),
                                    default=["P50", "P75", "P90"])
        horizon = int(c3.number_input("Assessment horizon (years)", 5, 25, YA.HYBRID_DEFAULTS["horizon_years"]))
        fast = c4.checkbox("Fast mode (simulate 5 years, interpolate)", True)
        c1, c2, c3, c4 = st.columns(4)
        sigma_w = c1.number_input("Wind uncertainty σ (%)", 1.0, 25.0, round(YA.rss(YA.WIND_DEFAULTS["uncertainty"]), 2), 0.1,
                                  help="Combined RSS of the wind uncertainty components (editable below)")
        sigma_s = c2.number_input("Solar uncertainty σ (%)", 1.0, 15.0, 4.87, 0.1)
        trans_loss = c3.number_input("Transmission loss to PoI (%)", 0.0, 5.0,
                                     YA.HYBRID_DEFAULTS["transmission_loss_pct"], 0.05,
                                     help="Indicative loss line in the hybrid table; dispatch CUFs are already net")
        client_name = c4.text_input("Client name (report header)", "")

        st.markdown("**Wind loss chain** (multiplicative efficiencies) and **uncertainty components**")
        wl1, wl2 = st.columns(2)
        loss_df = wl1.data_editor(
            pd.DataFrame({"Loss item": list(YA.WIND_DEFAULTS["other_losses"].keys()),
                          "Efficiency": list(YA.WIND_DEFAULTS["other_losses"].values())}),
            hide_index=True, key="eya_loss_editor")
        unc_df = wl2.data_editor(
            pd.DataFrame({"Uncertainty": list(YA.WIND_DEFAULTS["uncertainty"].keys()),
                          "% on AEP": list(YA.WIND_DEFAULTS["uncertainty"].values())}),
            hide_index=True, key="eya_unc_editor")
        wc1, wc2, wc3 = st.columns(3)
        gross_gwh = wc1.number_input("Wind gross generation before wake (GWh)", 50.0, 800.0,
                                     YA.WIND_DEFAULTS["gross_gwh_before_wake"], 1.0)
        array_eff = wc2.number_input("Array (wake) efficiency (%)", 60.0, 100.0,
                                     100 * YA.WIND_DEFAULTS["array_efficiency"], 0.1) / 100.0
        free_ws = wc3.number_input("Free wind speed (m/s)", 4.0, 12.0, YA.WIND_DEFAULTS["free_ws"], 0.01)

        st.markdown("**Solar sites** (net P50 first-year generation and per-site uncertainty)")
        solar_df = st.data_editor(
            pd.DataFrame([{ "Site": s["name"], "AC MW": s["ac_mw"], "DC MWp": s["dc_mwp"],
                            "GHI (kWh/m2)": s["ghi"], "P50 Y1 (MWh)": s["p50_mwh_y1"],
                            "Uncertainty %": s["uncertainty_pct"],
                            "Meteo": s["meteo"], "Temp C": s["temp_c"]} for s in solar_site_defaults]),
            hide_index=True, key=f"eya_solar_editor_{solar_editor_suffix}")

    levels_t = tuple(levels_sel) if levels_sel else ("P50",)
    wind_over = dict(gross_gwh_before_wake=float(gross_gwh), array_efficiency=float(array_eff),
                     free_ws=float(free_ws),
                     other_losses=dict(zip(loss_df["Loss item"], loss_df["Efficiency"].astype(float))),
                     uncertainty=dict(zip(unc_df["Uncertainty"], unc_df["% on AEP"].astype(float))))
    solar_over = []
    for base, (_, row) in zip(solar_site_defaults, solar_df.iterrows()):
        s = dict(base)
        s.update(name=str(row["Site"]), ac_mw=float(row["AC MW"]), dc_mwp=float(row["DC MWp"]), ghi=float(row["GHI (kWh/m2)"]),
                 p50_mwh_y1=float(row["P50 Y1 (MWh)"]), uncertainty_pct=float(row["Uncertainty %"]),
                 meteo=str(row.get("Meteo", base.get("meteo", ""))),
                 temp_c=float(row.get("Temp C", base.get("temp_c", 0.0))))
        s["dc_ac"] = s["dc_mwp"] / s["ac_mw"] if s["ac_mw"] else 0.0
        solar_over.append(s)

    wind_res = YA.wind_eya(wind_over, levels=levels_t)
    solar_res = YA.solar_eya(solar_over, levels=levels_t)
    bess_res = YA.bess_tables(years=horizon)
    eya_pj = YA.eya_project(wind_over, solar_over) if eya_src.startswith("EYA") else project
    if fast:
        sim_years = tuple(sorted({1, horizon, *[y for y in (5, 10, 15, 20) if y <= horizon]}))
    else:
        sim_years = tuple(range(1, horizon + 1))
    eya_run_key = json.dumps({
        "source": eya_src,
        "project": E.project_to_dict(eya_pj),
        "levels": levels_t,
        "sim_years": sim_years,
        "horizon": horizon,
        "sigma_wind": float(sigma_w),
        "sigma_solar": float(sigma_s),
        "trans_loss": float(trans_loss),
        "wind": wind_over,
        "solar": solar_over,
    }, sort_keys=True)

    if st.button("Run hybrid EYA assessment", type="primary"):
        with st.spinner(f"Dispatching {len(levels_t)} P-levels x {len(sim_years)} years..."):
            st.session_state["eya_results"] = _eya_hybrid_cached(
                json.dumps(E.project_to_dict(eya_pj), sort_keys=True), levels_t, sim_years,
                horizon, float(sigma_w), float(sigma_s), float(trans_loss))
            st.session_state["eya_meta"] = dict(levels=levels_t, horizon=horizon, client=client_name,
                                                run_key=eya_run_key, source=eya_src)

    st.markdown("### 2. Wind EYA - " + wind_res["inputs"]["wtg_model"])
    w1, w2 = st.columns([3, 2])
    wf = wind_res["waterfall"]
    figw = go.Figure(go.Waterfall(
        x=[s for s, _ in wf], measure=["absolute"] + ["relative"] * (len(wf) - 1),
        y=[wf[0][1]] + [wf[i][1] - wf[i - 1][1] for i in range(1, len(wf))]))
    figw.update_layout(height=380, margin=dict(l=10, r=10, t=30, b=10),
                       title=f"Gross {wind_res['gross_gwh']:.1f} GWh -> Net P50 {wind_res['net_p50_gwh']:.1f} GWh",
                       yaxis_title="GWh", xaxis=dict(tickfont=dict(size=9)))
    w1.plotly_chart(figw, width="stretch", key="eya_wind_waterfall_chart")
    metric_level = "P50" if "P50" in wind_res["plevels"] else next(iter(wind_res["plevels"]))
    w2.metric(f"Net {metric_level} / PLF", f"{wind_res['plevels'][metric_level]['net_gwh']:.1f} GWh / {100*wind_res['plevels'][metric_level]['plf']:.2f}%")
    w2.metric("Combined uncertainty (RSS)", f"{wind_res['sigma_pct']:.2f}%")
    w2.dataframe(pd.DataFrame({
        "P-level": list(wind_res["plevels"].keys()),
        "Net GWh": [round(v["net_gwh"], 2) for v in wind_res["plevels"].values()],
        "Net PLF %": [round(100 * v["plf"], 2) for v in wind_res["plevels"].values()]}),
        hide_index=True, width="stretch")

    st.markdown("### 3. Solar EYA")
    sc = st.columns(len(solar_res))
    for col, s in zip(sc, solar_res):
        col.markdown(f"**{s['name']}** — {s['ac_mw']:.0f} MWac / {s['dc_mwp']:.0f} MWp · GHI {s['ghi']:.0f} kWh/m² · {s['meteo']}")
        if s.get("pvsyst_source"):
            col.caption(
                f"PVsyst source: {s['pvsyst_source']} · Applied {s.get('pvsyst_applied_level', 'P50')} · Specific yield "
                f"{float(s.get('pvsyst_specific_yield') or 0):.0f} kWh/kWp · PR "
                f"{float(s.get('pvsyst_pr_pct') or 0):.2f}%"
            )
        col.dataframe(pd.DataFrame({
            "P-level": list(s["plevels"].keys()),
            "Gen Y1 (MWh)": [round(v["mwh_y1"]) for v in s["plevels"].values()],
            "DC CUF %": [round(100 * v["dc_cuf"], 2) for v in s["plevels"].values()],
            "AC CUF %": [round(100 * v["ac_cuf"], 2) for v in s["plevels"].values()]}),
            hide_index=True, width="stretch")

    st.markdown("### 4. BESS - SoH and RTE schedules")
    bc = st.columns(len(bess_res))
    for col, b in zip(bc, bess_res):
        sp = b["spec"]
        col.markdown(f"**{sp['name']}** - PoI {sp['poi_mwh']:.0f} MWh / {sp['power_mw']:.0f} MW · {sp['c_rate']} · augmentation {sp['augmentation']}")
        figb = go.Figure()
        figb.add_scatter(x=b["schedule"]["Year"], y=b["schedule"]["SoH (%)"], name="SoH %")
        figb.add_scatter(x=b["schedule"]["Year"], y=b["schedule"]["RTE (%)"], name="RTE %")
        figb.update_layout(height=260, margin=dict(l=10, r=10, t=10, b=10))
        col.plotly_chart(figb, width="stretch", key=f"eya_bess_schedule_{E._safe_name(sp['name'])}")
        with col.expander("Schedule table"):
            st.dataframe(b["schedule"], hide_index=True, width="stretch")

    meta = st.session_state.get("eya_meta", {})
    results_are_current = bool(st.session_state.get("eya_results")) and meta.get("run_key") == eya_run_key
    if st.session_state.get("eya_results") and not results_are_current:
        st.warning("EYA inputs changed after the last run. Click **Run hybrid EYA assessment** to refresh hybrid results and downloads.")

    if results_are_current:
        results = st.session_state["eya_results"]
        st.markdown("### 6. Hybrid EYA results - average over horizon")
        summary = YA.hybrid_summary_table(results)
        st.dataframe(summary, hide_index=True, width="stretch", height=560)

        st.markdown("### Monthly shortage vs 90% peak availability floor")
        ms = YA.monthly_shortage_table(results)
        figm = go.Figure()
        for lv in results:
            figm.add_bar(x=ms["Month"], y=ms[lv], name=lv)
        figm.update_layout(height=320, barmode="group", yaxis_title="GWh (avg per year)",
                           margin=dict(l=10, r=10, t=10, b=10))
        st.plotly_chart(figm, width="stretch", key="eya_monthly_shortage_chart")

        st.markdown("### 7. Annexure - yearly results")
        lv_pick = st.selectbox("P-level", list(results.keys()))
        st.caption(f"Simulated years: {results[lv_pick]['sim_years']} (others interpolated)" if fast
                   else "All years simulated hourly.")
        st.dataframe(results[lv_pick]["yearly"].round(2), hide_index=True, width="stretch", height=420)

        d1, d2, d3 = st.columns(3)
        d1.download_button("Download hybrid summary CSV", summary.to_csv(index=False).encode(),
                           "eya_hybrid_summary.csv", "text/csv", key="eya_download_summary_csv")
        d2.download_button(f"Download yearly annexure CSV ({lv_pick})",
                           results[lv_pick]["yearly"].to_csv(index=False).encode(),
                           f"eya_yearly_{lv_pick}.csv", "text/csv", key=f"eya_download_yearly_{lv_pick}")
        html = YA.build_html_report(wind_res, solar_res, bess_res, results,
                                    {**YA.HYBRID_DEFAULTS, "horizon_years": meta.get("horizon", horizon)},
                                    eya_pj.name, client=meta.get("client", ""))
        d3.download_button("Download full EYA report (HTML, printable)", html.encode(),
                           "hybrid_eya_report.html", "text/html", key="eya_download_html_report")
        st.caption(
            "Methodology note: this assessment uses the app's chronological greedy dispatch; the reference "
            "consultant report uses linear programming. Cross-validation on the report portfolio shows "
            "component generation matching the report exactly and hybrid PPA energy within ~6% "
            "(conservative). Screening-grade — not a substitute for a bankable independent EYA."
        )
    else:
        st.info("Set EYA inputs above and click **Run hybrid EYA assessment** to generate sections 1, 6 and 7 "
                "(hybrid results, monthly shortage, yearly annexure) and the downloadable report.")
