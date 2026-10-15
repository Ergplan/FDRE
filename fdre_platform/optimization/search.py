"""Contract-term dispatch runs and the outer tariff search (workflow A), and the fixed
tariff evaluation (workflow B). See docs/platform/FORMULATION.md sections 6 to 8."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from fdre_platform.finance.model import FinanceAssumptions, FinanceResult, OperatingYear, evaluate

from . import certify, model
from .spec import DispatchSpec

FAST_YEARS = (1, 5, 10, 15, 20, 25)
TARIFF_TOLERANCE = 0.005


@dataclass
class TermResult:
    """Dispatch of the contract term at one tariff: the years solved, the interpolated
    aggregates per year and the worst solver status."""

    status: str                           # optimal | feasible_time_limit | infeasible | failed | cancelled
    years_solved: list[int]
    years_interpolated: list[int]
    per_year: list[dict[str, Any]]        # aggregates for every contract year
    solves: list[dict[str, Any]]          # one entry per solved year: status, gap, bound, seconds, certified
    worst_gap: float | None
    dispatch_year1: dict[str, Any] | None
    certification_year1: dict[str, Any] | None
    certification_last: dict[str, Any] | None
    seconds: float


def run_term(spec_for_year: Callable[[int, float], DispatchSpec], tariff: float, ppa_years: int, *, years_mode: str = "fast", time_limit_seconds: float = 120.0, mip_rel_gap: float = 0.01, cancel_check: Callable[[dict[str, Any] | None], bool] | None = None, keep_dispatch: bool = True, solve_years: list[int] | None = None) -> TermResult:
    """years_mode: exact (every year), fast (years 1, 5, 10, 15, 20, 25 and the last),
    or an explicit `solve_years` list (screening); the other years are interpolated and
    labelled as such."""
    if solve_years:
        years = sorted({int(y) for y in solve_years if 1 <= int(y) <= ppa_years} | {1, ppa_years})
    else:
        years = list(range(1, ppa_years + 1)) if years_mode == "exact" else sorted({y for y in FAST_YEARS if y <= ppa_years} | {1, ppa_years})
    solved: dict[int, dict[str, Any]] = {}
    solves: list[dict[str, Any]] = []
    seconds = 0.0
    worst = "optimal"
    worst_gap: float | None = 0.0
    dispatch_year1 = None
    cert1 = None
    cert_last = None
    for y in years:
        if cancel_check is not None and not cancel_check({"phase": "dispatch", "year": y, "tariff": tariff}):
            return TermResult("cancelled", list(solved), [], [], solves, worst_gap, dispatch_year1, cert1, cert_last, seconds)
        spec = spec_for_year(y, tariff)
        res = model.solve(spec, time_limit_seconds=time_limit_seconds, mip_rel_gap=mip_rel_gap)
        seconds += res.wall_seconds
        entry = {"year": y, "status": res.status, "solver_status": res.solver_status, "objective_inr": res.objective, "best_bound_inr": res.best_bound, "gap": res.gap, "seconds": res.wall_seconds, "variables": res.n_variables, "constraints": res.n_constraints, "binaries": res.n_binaries, "certified": None}
        if res.status in ("optimal", "feasible_time_limit"):
            rep = certify.certify(spec, res.dispatch, solver_objective=res.objective)
            entry["certified"] = rep.status
            entry["certification_issues"] = len(rep.issues)
            if rep.status != "certified":
                entry["status"] = "failed_certification"
                worst = "failed"
            if y == years[0]:
                cert1 = rep.as_dict()
                if keep_dispatch:
                    dispatch_year1 = _slim(res.dispatch)
            if y == years[-1]:
                cert_last = rep.as_dict()
            solved[y] = {**res.aggregates, "year": y, "tariff": tariff, "solver_status": res.status, "gap": res.gap}
            if res.status == "feasible_time_limit" and worst == "optimal":
                worst = "feasible_time_limit"
            if res.gap is not None and (worst_gap is None or res.gap > worst_gap):
                worst_gap = res.gap
        else:
            solves.append(entry)
            return TermResult(res.status if res.status in ("infeasible", "unbounded") else "failed", list(solved), [], [], solves, worst_gap, dispatch_year1, cert1, cert_last, seconds)
        solves.append(entry)
    per_year = _interpolate(solved, ppa_years)
    return TermResult(worst, years, [y for y in range(1, ppa_years + 1) if y not in solved], per_year, solves, worst_gap, dispatch_year1, cert1, cert_last, round(seconds, 3))


def _slim(d: dict[str, Any]) -> dict[str, Any]:
    """Dispatch arrays as lists (for the artifact), rounded."""

    def conv(x: Any) -> Any:
        if isinstance(x, np.ndarray):
            return np.round(x, 4).tolist()
        if isinstance(x, dict):
            return {k: conv(v) for k, v in x.items()}
        return x

    return conv(d)


NUMERIC_KEYS = ("ppa_mwh", "merchant_mwh", "merchant_revenue_inr", "iex_purchase_mwh", "iex_purchase_cost_inr", "external_green_mwh", "fuel_cost_inr", "thermal_variable_cost_inr", "startup_cost_inr", "total_penalty_mwh", "peak_shortfall_mwh", "annual_shortfall_mwh", "re_available_mwh", "re_curtailed_mwh", "re_to_ppa_mwh", "re_charged_mwh", "bess_charge_mwh", "bess_discharge_mwh", "bess_discharge_to_ppa_mwh", "thermal_to_ppa_mwh", "renewable_delivered_mwh", "annual_cuf")


def _interpolate(solved: dict[int, dict[str, Any]], n: int) -> list[dict[str, Any]]:
    ys = sorted(solved)
    out = []
    for y in range(1, n + 1):
        if y in solved:
            out.append({**solved[y], "interpolated": False})
            continue
        lo = max(k for k in ys if k < y)
        hi = min((k for k in ys if k > y), default=lo)
        w = 0.0 if hi == lo else (y - lo) / (hi - lo)
        row: dict[str, Any] = {"year": y, "interpolated": True, "tariff": solved[lo]["tariff"]}
        for k in NUMERIC_KEYS:
            a, b = solved[lo].get(k), solved[hi].get(k)
            if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                row[k] = a + (b - a) * w
            elif isinstance(a, dict):
                row[k] = {name: a[name] + (b.get(name, a[name]) - a[name]) * w for name in a}
        row["peak_ok"] = bool(solved[lo].get("peak_ok", True)) and bool(solved[hi].get("peak_ok", True))
        row["annual_cuf_ok"] = bool(solved[lo].get("annual_cuf_ok", True)) and bool(solved[hi].get("annual_cuf_ok", True))
        out.append(row)
    return out


def operating_years(per_year: list[dict[str, Any]]) -> list[OperatingYear]:
    return [OperatingYear(ppa_mwh=r["ppa_mwh"], merchant_mwh=r.get("merchant_mwh", 0.0), merchant_revenue_inr=r.get("merchant_revenue_inr", 0.0), purchase_mwh=r.get("iex_purchase_mwh", 0.0), purchase_cost_inr=r.get("iex_purchase_cost_inr", 0.0), penalty_mwh=r.get("total_penalty_mwh", 0.0), fuel_cost_inr=r.get("fuel_cost_inr", 0.0), thermal_variable_cost_inr=r.get("thermal_variable_cost_inr", 0.0), startup_cost_inr=r.get("startup_cost_inr", 0.0), external_green_mwh=r.get("external_green_mwh", 0.0)) for r in per_year]


@dataclass
class SearchResult:
    status: str                     # found | infeasible | not_reached | time_limited | failed | cancelled | non_monotone
    tariff: float | None
    finance: FinanceResult | None
    term: TermResult | None
    samples: list[dict[str, Any]] = field(default_factory=list)
    monotone: bool | None = None
    dispatch_invariant: bool | None = None
    iterations: int = 0
    milp_solves: int = 0
    certification_boundary: str = ""
    notes: list[str] = field(default_factory=list)


def _aggregates_equal(a: TermResult, b: TermResult, rel: float = 1e-6) -> bool:
    for ra, rb in zip(a.per_year, b.per_year, strict=False):
        for k in ("ppa_mwh", "merchant_mwh", "total_penalty_mwh", "iex_purchase_mwh", "fuel_cost_inr"):
            x, y = ra.get(k, 0.0), rb.get(k, 0.0)
            if abs(x - y) > rel * max(1.0, abs(x), abs(y)):
                return False
    return True


def required_tariff(spec_for_year: Callable[[int, float], DispatchSpec], assumptions: FinanceAssumptions, *, lo: float = 1.0, hi: float = 12.0, psm: float = 0.0, penalty_multiplier: float = 1.5, external_green_price: float = 0.0, years_mode: str = "fast", time_limit_seconds: float = 120.0, mip_rel_gap: float = 0.01, cancel_check=None, progress=None, solve_years: list[int] | None = None) -> SearchResult:
    """Workflow A: the lowest tariff at which the dispatch (re-optimised at that tariff)
    meets the equity IRR target and the DSCR floor."""
    samples: list[dict[str, Any]] = []
    cache: dict[float, TermResult] = {}
    notes: list[str] = []
    solves = 0

    def term_at(t: float) -> TermResult:
        nonlocal solves
        key = round(t, 6)
        if key not in cache:
            cache[key] = run_term(spec_for_year, t, assumptions.ppa_years, years_mode=years_mode, time_limit_seconds=time_limit_seconds, mip_rel_gap=mip_rel_gap, cancel_check=cancel_check, keep_dispatch=False, solve_years=solve_years)
            solves += len(cache[key].years_solved)
        return cache[key]

    def finance_at(t: float, term: TermResult) -> FinanceResult:
        return evaluate(assumptions, operating_years(term.per_year), t, psm_charge_inr_per_kwh=psm, penalty_multiplier=penalty_multiplier, external_green_price_inr_per_kwh=external_green_price)

    def sample(t: float, term: TermResult | None = None) -> dict[str, Any]:
        term = term or term_at(t)
        if term.status in ("infeasible", "failed", "cancelled", "unbounded"):
            row = {"tariff": t, "status": term.status, "equity_irr": None, "min_dscr": None, "meets": False}
        else:
            fin = finance_at(t, term)
            row = {"tariff": t, "status": term.status, "equity_irr": fin.equity_irr, "min_dscr": fin.min_dscr, "meets": fin.meets_target, "gap": term.worst_gap, "roots": fin.equity_irr_roots}
        samples.append(row)
        if progress is not None:
            progress({"phase": "tariff_search", "samples": len(samples), "tariff": t, "status": row["status"], "equity_irr": row["equity_irr"]})
        return row

    boundary = "The MILP gap certifies each fixed-tariff dispatch within its gap; the tariff reported is the smallest sampled tariff meeting the financial target under the monotonicity checked at the sampled points. It is not a global optimality certificate for the nonlinear tariff-IRR relationship."
    s_lo = sample(lo)
    if s_lo["status"] in ("infeasible", "failed", "cancelled", "unbounded"):
        return SearchResult(s_lo["status"] if s_lo["status"] != "unbounded" else "failed", None, None, cache.get(round(lo, 6)), samples, None, None, 0, solves, boundary, notes)
    s_hi = sample(hi)
    if s_hi["status"] in ("infeasible", "failed", "cancelled"):
        return SearchResult(s_hi["status"], None, None, cache.get(round(hi, 6)), samples, None, None, 0, solves, boundary, notes)
    if s_lo["meets"]:
        fin = finance_at(lo, term_at(lo))
        notes.append("the lower bound already meets the target; the required tariff is at or below it")
        return SearchResult("found", lo, fin, term_at(lo), samples, None, None, 0, solves, boundary, notes)
    if not s_hi["meets"]:
        return SearchResult("not_reached", None, finance_at(hi, term_at(hi)), term_at(hi), samples, None, None, 0, solves, boundary, notes + [f"the target is not met even at {hi} INR/kWh"])
    mid = 0.5 * (lo + hi)
    s_mid = sample(mid)
    irrs = [s_lo["equity_irr"], s_mid["equity_irr"], s_hi["equity_irr"]]
    monotone = all(a is not None and b is not None and b >= a - 1e-6 for a, b in zip(irrs, irrs[1:], strict=False))
    invariant = _aggregates_equal(term_at(lo), term_at(hi)) and _aggregates_equal(term_at(lo), term_at(mid))
    if invariant:
        notes.append("dispatch aggregates are identical across the tariff range: the dispatch is tariff-invariant here and the search runs on the financial evaluator only")
    iterations = 0
    time_limited = any(cache[k].status == "feasible_time_limit" for k in cache)
    if not monotone:
        notes.append("equity IRR is not monotone in the tariff at the sampled points; a grid search over the range is used instead of bisection")
        grid = np.linspace(lo, hi, 23)
        best = None
        for t in grid:
            row = sample(float(t), term_at(lo) if invariant else None)
            iterations += 1
            if row["meets"]:
                best = float(t)
                break
        if best is None:
            return SearchResult("not_reached", None, None, None, samples, False, invariant, iterations, solves, boundary, notes)
        term = term_at(lo) if invariant else term_at(best)
        return SearchResult("non_monotone", best, finance_at(best, term), term, samples, False, invariant, iterations, solves, boundary, notes)
    a, b = lo, hi
    base_term = term_at(lo)
    while b - a > TARIFF_TOLERANCE and iterations < 40:
        iterations += 1
        t = 0.5 * (a + b)
        term = base_term if invariant else term_at(t)
        if term.status in ("infeasible", "failed", "cancelled"):
            return SearchResult(term.status, None, None, term, samples, True, invariant, iterations, solves, boundary, notes)
        row = sample(t, term)
        if row["meets"]:
            b = t
        else:
            a = t
        if term.status == "feasible_time_limit":
            time_limited = True
    b = min(s["tariff"] for s in samples if s["meets"])  # the smallest sampled tariff that meets the target
    final_term = base_term if invariant else term_at(b)
    if not invariant and final_term.status not in ("optimal", "feasible_time_limit"):
        return SearchResult(final_term.status, None, None, final_term, samples, True, invariant, iterations, solves, boundary, notes)
    fin = finance_at(b, final_term)
    status = "time_limited" if time_limited else "found"
    if time_limited:
        notes.append("one or more subproblems stopped on the time limit; the dispatch used is a feasible incumbent certified by the validator, not a proven optimum, so the tariff is an upper bound on the required tariff")
    return SearchResult(status, b, fin, final_term, samples, True, invariant, iterations, solves, boundary, notes)


def fixed_tariff(spec_for_year: Callable[[int, float], DispatchSpec], assumptions: FinanceAssumptions, tariff: float, *, psm: float = 0.0, penalty_multiplier: float = 1.5, external_green_price: float = 0.0, years_mode: str = "fast", time_limit_seconds: float = 120.0, mip_rel_gap: float = 0.01, cancel_check=None, solve_years: list[int] | None = None) -> tuple[TermResult, FinanceResult | None]:
    """Workflow B with optimised dispatch: the tariff and capacities are held fixed."""
    term = run_term(spec_for_year, tariff, assumptions.ppa_years, years_mode=years_mode, time_limit_seconds=time_limit_seconds, mip_rel_gap=mip_rel_gap, cancel_check=cancel_check, solve_years=solve_years)
    if term.status in ("infeasible", "failed", "cancelled", "unbounded"):
        return term, None
    return term, evaluate(assumptions, operating_years(term.per_year), tariff, psm_charge_inr_per_kwh=psm, penalty_multiplier=penalty_multiplier, external_green_price_inr_per_kwh=external_green_price)


def sensitivities(assumptions: FinanceAssumptions, per_year: list[dict[str, Any]], tariff: float, *, psm: float = 0.0, penalty_multiplier: float = 1.5) -> list[dict[str, Any]]:
    """One-at-a-time financial sensitivities on the fixed dispatch (no re-dispatch)."""
    from dataclasses import replace

    ops = operating_years(per_year)
    base = evaluate(assumptions, ops, tariff, psm_charge_inr_per_kwh=psm, penalty_multiplier=penalty_multiplier)
    out = [{"case": "base", "equity_irr": base.equity_irr, "project_irr": base.project_irr, "npv_equity_cr": base.npv_equity_inr / 1e7, "min_dscr": base.min_dscr}]
    cases = [
        ("tariff -5%", lambda: evaluate(assumptions, ops, tariff * 0.95, psm_charge_inr_per_kwh=psm, penalty_multiplier=penalty_multiplier)),
        ("tariff +5%", lambda: evaluate(assumptions, ops, tariff * 1.05, psm_charge_inr_per_kwh=psm, penalty_multiplier=penalty_multiplier)),
        ("capex +10%", lambda: evaluate(replace(assumptions, capex=[replace(c, amount_inr=c.amount_inr * 1.1) for c in assumptions.capex]), ops, tariff, psm_charge_inr_per_kwh=psm, penalty_multiplier=penalty_multiplier)),
        ("capex -10%", lambda: evaluate(replace(assumptions, capex=[replace(c, amount_inr=c.amount_inr * 0.9) for c in assumptions.capex]), ops, tariff, psm_charge_inr_per_kwh=psm, penalty_multiplier=penalty_multiplier)),
        ("interest +100 bp", lambda: evaluate(replace(assumptions, interest_rate=assumptions.interest_rate + 0.01), ops, tariff, psm_charge_inr_per_kwh=psm, penalty_multiplier=penalty_multiplier)),
        ("energy -5%", lambda: evaluate(assumptions, [replace(o, ppa_mwh=o.ppa_mwh * 0.95) for o in ops], tariff, psm_charge_inr_per_kwh=psm, penalty_multiplier=penalty_multiplier)),
        ("opex +10%", lambda: evaluate(replace(assumptions, opex=[replace(o, amount_inr_per_year=o.amount_inr_per_year * 1.1) for o in assumptions.opex]), ops, tariff, psm_charge_inr_per_kwh=psm, penalty_multiplier=penalty_multiplier)),
    ]
    for name, fn in cases:
        r = fn()
        out.append({"case": name, "equity_irr": r.equity_irr, "project_irr": r.project_irr, "npv_equity_cr": r.npv_equity_inr / 1e7, "min_dscr": r.min_dscr})
    return out
