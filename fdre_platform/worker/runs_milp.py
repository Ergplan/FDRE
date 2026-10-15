"""Run kinds built on the MILP formulation and finance.v1:

  bid_tariff        workflow A: tariff search over fixed-tariff MILP subproblems
  fixed_tariff      workflow B: tariff and capacities fixed; dispatch by MILP (dispatch=milp)
                    or by the legacy rule-based engine (dispatch=rules); finance reported
  milp_dispatch     one fixed-tariff dispatch of the contract term with certification
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sqlalchemy.orm import Session

from fdre_platform.finance.model import FinanceAssumptions, assumptions_from_project
from fdre_platform.models import Profile
from fdre_platform.optimization import search
from fdre_platform.optimization.spec import DispatchSpec, spec_from_inputs

Heartbeat = Callable[[dict[str, Any] | None], bool]


class RunCancelled(Exception):
    pass


def _price_lookup(session: Session, organization_id: str):
    def lookup(profile_id: str) -> list[float] | None:
        p = session.get(Profile, profile_id)
        if p is None or p.organization_id != organization_id:
            return None
        return list(p.hourly)

    return lookup


def _spec_factory(inputs: dict[str, Any], options: dict[str, Any], lookup) -> Callable[[int, float], DispatchSpec]:
    resolution = int(options.get("resolution_minutes", 60))
    scenario = options.get("market_scenario")

    def spec_for_year(year: int, tariff: float) -> DispatchSpec:
        return spec_from_inputs(inputs, tariff=tariff, year=year, resolution_minutes=resolution, market_scenario=scenario, price_lookup=lookup)

    return spec_for_year


def _assumptions(inputs: dict[str, Any], options: dict[str, Any]) -> FinanceAssumptions:
    a = assumptions_from_project(inputs.get("project", {}), inputs.get("supply"))
    fin = inputs.get("finance") or {}
    for key in ("target_equity_irr", "min_dscr", "debt_fraction", "interest_rate", "tenor_years", "discount_rate", "sculpt_target_dscr"):
        if key in fin:
            setattr(a, key, type(getattr(a, key))(fin[key]))
    return a


def _tender_params(inputs: dict[str, Any]) -> dict[str, float]:
    t = inputs.get("project", {}).get("tender", {})
    return {"psm": float(t.get("psm_charge_rs_per_kwh", 0.0)), "penalty_multiplier": float(t.get("penalty_multiplier", 1.5)), "external_green_price": float(t.get("external_green_price_rs_per_kwh", 0.0))}


def _cancel_check(heartbeat: Heartbeat):
    def check(progress: dict[str, Any] | None) -> bool:
        return heartbeat(progress)

    return check


def _term_dict(term: search.TermResult) -> dict[str, Any]:
    return {
        "status": term.status, "years_solved": term.years_solved, "years_interpolated": term.years_interpolated, "worst_gap": term.worst_gap, "seconds": term.seconds, "solves": term.solves,
        "per_year": term.per_year, "certification_year1": term.certification_year1, "certification_last": term.certification_last,
    }


def _finance_dict(fin) -> dict[str, Any] | None:
    if fin is None:
        return None
    st = fin.statement
    return {**fin.summary(), "statement": {k: [float(x) for x in getattr(st, k)] for k in ("revenue_ppa", "revenue_merchant", "penalties", "purchases", "fuel_and_variable", "fixed_opex", "insurance", "wc_interest", "ebitda", "book_depreciation", "interest", "principal", "debt_opening", "debt_closing", "tax", "tax_depreciation", "pat", "delta_wc", "augmentation", "cfads", "debt_service", "dscr", "fcfe", "terminal")}, "years": st.years, "equity_cash_flows": fin.equity_cash_flows, "project_cash_flows": fin.project_cash_flows, "assumptions_version": fin.version}


def _binding(term: search.TermResult) -> list[str]:
    out = []
    y1 = term.per_year[0] if term.per_year else {}
    if y1.get("peak_shortfall_mwh", 0) > 1e-6:
        out.append(f"monthly peak availability (shortfall {y1['peak_shortfall_mwh']:.1f} MWh in year 1)")
    if y1.get("annual_shortfall_mwh", 0) > 1e-6:
        out.append(f"annual CUF floor (shortfall {y1['annual_shortfall_mwh']:.1f} MWh in year 1)")
    if y1.get("re_curtailed_mwh", 0) > 1e-6:
        out.append(f"curtailment {y1['re_curtailed_mwh']:.0f} MWh in year 1 (interconnection, contracted capacity or storage limits)")
    if y1.get("external_share", 0) and abs(y1["external_share"]) > 0:
        out.append(f"external sourcing used: {100 * y1['external_share']:.2f}% of delivered energy")
    return out


def _json_clean(value: Any) -> Any:
    """JSONB-safe: numpy scalars to Python, non-finite floats to None."""
    import math

    import numpy as np

    if isinstance(value, dict):
        return {str(k): _json_clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_clean(v) for v in value]
    if isinstance(value, np.ndarray):
        return _json_clean(value.tolist())
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        f = float(value)
        return f if math.isfinite(f) else None
    return value


def execute(kind: str, inputs: dict[str, Any], options: dict[str, Any], *, session: Session, organization_id: str, heartbeat: Heartbeat) -> tuple[dict[str, Any], dict[str, Any], str]:
    """Returns (result, metrics, run status), JSON-clean."""
    result, metrics, status = _execute(kind, inputs, options, session=session, organization_id=organization_id, heartbeat=heartbeat)
    return _json_clean(result), _json_clean(metrics), status


def _execute(kind: str, inputs: dict[str, Any], options: dict[str, Any], *, session: Session, organization_id: str, heartbeat: Heartbeat) -> tuple[dict[str, Any], dict[str, Any], str]:
    lookup = _price_lookup(session, organization_id)
    factory = _spec_factory(inputs, options, lookup)
    assumptions = _assumptions(inputs, options)
    params = _tender_params(inputs)
    years_mode = options.get("years_mode", "fast")
    time_limit = float(options.get("time_limit_seconds", 120.0))
    gap = float(options.get("mip_rel_gap", 0.01))
    cancel = _cancel_check(heartbeat)
    solve_years = options.get("solve_years")
    if kind == "bid_tariff":
        res = search.required_tariff(factory, assumptions, lo=float(options.get("tariff_lo", 1.0)), hi=float(options.get("tariff_hi", 12.0)), psm=params["psm"], penalty_multiplier=params["penalty_multiplier"], external_green_price=params["external_green_price"], years_mode=years_mode, time_limit_seconds=time_limit, mip_rel_gap=gap, cancel_check=cancel, progress=heartbeat, solve_years=solve_years)
        status = {"found": "succeeded", "non_monotone": "succeeded", "time_limited": "time_limited", "infeasible": "infeasible", "not_reached": "infeasible", "failed": "failed", "cancelled": "cancelled"}[res.status]
        result = {
            "mode": "bid_tariff_search", "workflow": "A", "search_status": res.status, "tariff": res.tariff, "tariff_label": f"Rs {res.tariff:.3f}/kWh" if res.tariff is not None else "not found",
            "finance": _finance_dict(res.finance), "term": _term_dict(res.term) if res.term else None, "samples": res.samples, "monotone": res.monotone, "dispatch_invariant": res.dispatch_invariant,
            "iterations": res.iterations, "milp_solves": res.milp_solves, "certification_boundary": res.certification_boundary, "notes": res.notes,
            "binding": _binding(res.term) if res.term else [], "sensitivities": search.sensitivities(assumptions, res.term.per_year, res.tariff, psm=params["psm"], penalty_multiplier=params["penalty_multiplier"]) if res.term and res.tariff else [],
            "dispatch_year1": res.term.dispatch_year1 if res.term else None, "assumptions": _assumptions_dict(assumptions),
        }
        metrics = {"tariff_rs_per_kwh": res.tariff, "status_reason": res.status, "solver": "HiGHS MILP (milp.v1) + finance.v1 tariff search", "gap": res.term.worst_gap if res.term else None, "milp_solves": res.milp_solves, "iterations": res.iterations, "equity_irr": res.finance.equity_irr if res.finance else None, "min_dscr": res.finance.min_dscr if res.finance else None}
        return result, metrics, status
    if kind in ("fixed_tariff", "milp_dispatch"):
        tariff = float(options.get("tariff") or inputs.get("finance", {}).get("tariff") or 0.0)
        if tariff <= 0:
            raise ValueError("a fixed-tariff run needs options.tariff (INR/kWh)")
        dispatch_mode = options.get("dispatch", "milp")
        if dispatch_mode == "rules" and kind == "fixed_tariff":
            return _rules_dispatch(inputs, options, tariff, assumptions, params)
        term, fin = search.fixed_tariff(factory, assumptions, tariff, psm=params["psm"], penalty_multiplier=params["penalty_multiplier"], external_green_price=params["external_green_price"], years_mode=years_mode, time_limit_seconds=time_limit, mip_rel_gap=gap, cancel_check=cancel, solve_years=solve_years)
        status = {"optimal": "succeeded", "feasible_time_limit": "time_limited", "infeasible": "infeasible", "failed": "failed", "cancelled": "cancelled", "unbounded": "failed"}[term.status]
        result = {
            "mode": "fixed_tariff_milp" if kind == "fixed_tariff" else "milp_dispatch", "workflow": "B" if kind == "fixed_tariff" else "dispatch", "tariff": tariff, "tariff_label": f"Rs {tariff:.3f}/kWh (fixed)", "capacities_fixed": True, "dispatch": dispatch_mode,
            "finance": _finance_dict(fin), "term": _term_dict(term), "binding": _binding(term), "notes": ["capacities and tariff held fixed; dispatch optimised by the MILP" if dispatch_mode == "milp" else "rule-based dispatch"],
            "sensitivities": search.sensitivities(assumptions, term.per_year, tariff, psm=params["psm"], penalty_multiplier=params["penalty_multiplier"]) if term.per_year else [], "dispatch_year1": term.dispatch_year1, "assumptions": _assumptions_dict(assumptions),
        }
        metrics = {"tariff_rs_per_kwh": tariff, "status_reason": term.status, "solver": "HiGHS MILP (milp.v1)", "gap": term.worst_gap, "seconds_solver": term.seconds, "equity_irr": fin.equity_irr if fin else None, "project_irr": fin.project_irr if fin else None, "min_dscr": fin.min_dscr if fin else None, "npv_equity_cr": fin.npv_equity_inr / 1e7 if fin else None, "certified": (term.certification_year1 or {}).get("status")}
        return result, metrics, status
    raise ValueError(f"unknown run kind {kind}")


def _assumptions_dict(a: FinanceAssumptions) -> dict[str, Any]:
    return {"version": a.version, "ppa_years": a.ppa_years, "capex": [c.__dict__ for c in a.capex], "opex": [o.__dict__ for o in a.opex], "debt_fraction": a.debt_fraction, "interest_rate": a.interest_rate, "tenor_years": a.tenor_years, "repayment": a.repayment, "sculpt_target_dscr": a.sculpt_target_dscr, "tax_rate": a.tax_rate, "tax_wdv_rate": a.tax_wdv_rate, "discount_rate": a.discount_rate, "target_equity_irr": a.target_equity_irr, "min_dscr": a.min_dscr, "sources": a.sources, "augmentation": a.augmentation}


def _rules_dispatch(inputs: dict[str, Any], options: dict[str, Any], tariff: float, assumptions: FinanceAssumptions, params: dict[str, float]) -> tuple[dict[str, Any], dict[str, Any], str]:
    """Workflow B without optimisation: the legacy chronological rule-based dispatch at
    fixed capacities, then finance.v1 at the entered tariff."""
    import fdre_enterprise_engine as E
    from react_demo.backend import api as legacy

    from .handlers import _custom_cf

    project = legacy._project_from_payload(inputs.get("project"))
    years = legacy._years(options.get("years_mode", "fast"), project)
    custom_cf = _custom_cf(inputs, legacy, options)
    op, first = E.operating_case(project, years=years, custom_cf=custom_cf, return_first_year_hourly=True)
    per_year = []
    for _, row in op.iterrows():
        per_year.append({"year": int(row["year"]), "ppa_mwh": float(row["ppa_mwh"]), "merchant_mwh": float(row["merchant_mwh"]), "merchant_revenue_inr": float(row["merchant_mwh"]) * project.simulation.merchant_price_rs_per_kwh * 1000.0, "total_penalty_mwh": float(row["total_penalty_mwh"]), "external_green_mwh": float(row.get("external_green_mwh", 0.0)), "interpolated": False})
    fin = search.evaluate(assumptions, search.operating_years(per_year), tariff, psm_charge_inr_per_kwh=params["psm"], penalty_multiplier=params["penalty_multiplier"], external_green_price_inr_per_kwh=params["external_green_price"])
    result = {"mode": "fixed_tariff_rules", "workflow": "B", "tariff": tariff, "tariff_label": f"Rs {tariff:.3f}/kWh (fixed)", "capacities_fixed": True, "dispatch": "rules", "finance": _finance_dict(fin), "term": {"status": "rules", "years_solved": [int(y) for y in op["year"]], "years_interpolated": [], "per_year": per_year, "solves": []}, "binding": [], "notes": ["rule-based chronological dispatch (legacy engine); no optimisation"], "sensitivities": search.sensitivities(assumptions, per_year, tariff, psm=params["psm"], penalty_multiplier=params["penalty_multiplier"]), "assumptions": _assumptions_dict(assumptions)}
    metrics = {"tariff_rs_per_kwh": tariff, "status_reason": "rules", "solver": "legacy chronological rules", "equity_irr": fin.equity_irr, "project_irr": fin.project_irr, "min_dscr": fin.min_dscr, "npv_equity_cr": fin.npv_equity_inr / 1e7}
    return result, metrics, "succeeded"
