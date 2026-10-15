"""Independent certification of a dispatch: recompute the physics and the money from the
spec and the exported decisions, interval by interval, without reading anything back
from the solver. The pattern follows Ergplan/Replanner energy_core/validation/certify.py:
a residual read out of the model only proves the solver satisfied what it was given; it
cannot catch a constraint written wrongly, a unit converted twice or a cost never added."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .model import KWH_PER_MWH
from .spec import DispatchSpec


@dataclass
class Tolerances:
    power_mw: float = 1e-5
    energy_mwh: float = 1e-4
    money_rel: float = 1e-6
    money_abs_inr: float = 1.0


@dataclass
class Issue:
    check: str
    residual: float
    tolerance: float
    units: str
    detail: str
    interval: int | None = None


@dataclass
class Report:
    status: str                      # certified | failed
    checks_run: list[str] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)
    max_residual: dict[str, float] = field(default_factory=dict)
    intervals_checked: int = 0
    objective_recomputed_inr: float | None = None
    objective_solver_inr: float | None = None
    compliance: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"status": self.status, "checks_run": self.checks_run, "issues": [i.__dict__ for i in self.issues[:50]], "issue_count": len(self.issues), "max_residual": self.max_residual, "intervals_checked": self.intervals_checked, "objective_recomputed_inr": self.objective_recomputed_inr, "objective_solver_inr": self.objective_solver_inr, "compliance": self.compliance}


def _worst(rep: Report, name: str, resid: np.ndarray, tol: float, units: str, detail: str, *, two_sided: bool = True) -> None:
    a = np.abs(resid) if two_sided else np.maximum(resid, 0.0)
    rep.max_residual[name] = float(a.max()) if a.size else 0.0
    bad = np.flatnonzero(a > tol)
    if bad.size:
        k = int(bad[np.argmax(a[bad])])
        rep.issues.append(Issue(check=name, residual=float(a[k]), tolerance=tol, units=units, detail=f"{detail}; {bad.size} interval(s) exceed tolerance", interval=k))
    rep.checks_run.append(name)


def certify(spec: DispatchSpec, dispatch: dict[str, Any], *, solver_objective: float | None, tol: Tolerances | None = None) -> Report:
    tol = tol or Tolerances()
    rep = Report(status="certified")
    T = spec.intervals
    dt = spec.dt_hours
    ob = spec.obligations
    delivered = np.asarray(dispatch["delivered_mw"], dtype=float)
    sold = np.asarray(dispatch["sold_mw"], dtype=float)
    rep.intervals_checked = T
    if delivered.shape[0] != T or sold.shape[0] != T:
        rep.issues.append(Issue("coverage", abs(delivered.shape[0] - T), 0, "intervals", f"{delivered.shape[0]} intervals exported, {T} expected"))
        rep.status = "failed"
        return rep
    rep.checks_run.append("coverage")
    # RE balance and bounds
    d_sum = np.zeros(T)
    s_sum = np.zeros(T)
    ch_from_re = np.zeros(T)
    for u in spec.re_units:
        r = dispatch["re"][u.name]
        avail = np.asarray(u.available_mw, dtype=float)
        parts = np.asarray(r["ppa"]) + np.asarray(r["sell"]) + np.asarray(r["curtail"]) + np.asarray(r["charge"])
        _worst(rep, f"re_balance:{u.name}", parts - avail, tol.power_mw, "MW", "ppa + sell + curtail + charge must equal available")
        _worst(rep, f"re_nonneg:{u.name}", -np.minimum(np.minimum(r["ppa"], r["sell"]), np.minimum(r["curtail"], r["charge"])), tol.power_mw, "MW", "flows must be non-negative", two_sided=False)
        d_sum += np.asarray(r["ppa"])
        s_sum += np.asarray(r["sell"])
        ch_from_re += np.asarray(r["charge"])
    # Thermal
    for u in spec.thermal_units:
        r = dispatch["thermal"][u.name]
        p = np.asarray(r["p"])
        on = np.asarray(r["on"])
        pmax = u.capacity_mw * (1 - u.aux_fraction) * u.availability * (1 if u.eligible else 0)
        pmin = u.min_stable_mw * (1 - u.aux_fraction) * u.availability
        _worst(rep, f"th_max:{u.name}", p - pmax * on, tol.power_mw, "MW", "output above Pmax x on", two_sided=False)
        _worst(rep, f"th_min:{u.name}", pmin * on - p, tol.power_mw, "MW", "output below minimum stable generation while on", two_sided=False)
        _worst(rep, f"th_split:{u.name}", p - np.asarray(r["ppa"]) - np.asarray(r["sell"]) - np.asarray(r["charge"]), tol.power_mw, "MW", "output must equal ppa + sell + charge")
        _worst(rep, f"th_binary:{u.name}", np.minimum(np.abs(on), np.abs(on - 1)), 1e-6, "", "commitment must be 0 or 1")
        if T > 1:
            up = p[1:] - p[:-1] - pmax * np.asarray(r["start"])[1:]
            down = p[:-1] - p[1:] - pmax * np.asarray(r["stop"])[1:]
            _worst(rep, f"th_ramp_up:{u.name}", up - u.ramp_up_mw_per_interval, tol.power_mw, "MW", "ramp up exceeds limit", two_sided=False)
            _worst(rep, f"th_ramp_down:{u.name}", down - u.ramp_down_mw_per_interval, tol.power_mw, "MW", "ramp down exceeds limit", two_sided=False)
            logic = (on[1:] - on[:-1]) - (np.asarray(r["start"])[1:] - np.asarray(r["stop"])[1:])
            _worst(rep, f"th_logic:{u.name}", logic, 1e-6, "", "on_t - on_{t-1} must equal start - stop")
            # Minimum up/down times from the recomputed state sequence
            viol_up = 0
            viol_down = 0
            run = 1
            for t in range(1, T):
                if on[t] == on[t - 1]:
                    run += 1
                else:
                    if on[t - 1] > 0.5 and run < u.min_up_intervals and t - run > 0:
                        viol_up += 1
                    if on[t - 1] < 0.5 and run < u.min_down_intervals and t - run > 0:
                        viol_down += 1
                    run = 1
            rep.max_residual[f"th_minup:{u.name}"] = float(viol_up)
            rep.max_residual[f"th_mindown:{u.name}"] = float(viol_down)
            rep.checks_run += [f"th_minup:{u.name}", f"th_mindown:{u.name}"]
            if viol_up:
                rep.issues.append(Issue(f"th_minup:{u.name}", viol_up, 0, "runs", "run shorter than minimum up time"))
            if viol_down:
                rep.issues.append(Issue(f"th_mindown:{u.name}", viol_down, 0, "runs", "stop shorter than minimum down time"))
        if u.annual_energy_cap_mwh is not None:
            _worst(rep, f"th_fuel_cap:{u.name}", np.array([p.sum() * dt - u.annual_energy_cap_mwh]), tol.energy_mwh, "MWh", "fuel energy cap exceeded", two_sided=False)
        d_sum += np.asarray(r["ppa"])
        s_sum += np.asarray(r["sell"])
    # BESS
    for bu in spec.bess_units:
        r = dispatch["bess"][bu.name]
        ch, dis, soc = (np.asarray(r[k], dtype=float) for k in ("charge", "discharge", "soc"))
        av = bu.availability
        _worst(rep, f"b_charge_limit:{bu.name}", ch - bu.charge_limit_mw * av, tol.power_mw, "MW", "charge above limit", two_sided=False)
        _worst(rep, f"b_discharge_limit:{bu.name}", dis - bu.discharge_limit_mw * av, tol.power_mw, "MW", "discharge above limit", two_sided=False)
        _worst(rep, f"b_power:{bu.name}", ch + dis - bu.power_mw * av, tol.power_mw, "MW", "charge + discharge above power rating", two_sided=False)
        _worst(rep, f"b_soc_bounds:{bu.name}", np.maximum(soc - bu.usable_mwh * av, -soc), tol.energy_mwh, "MWh", "SOC outside [0, usable]", two_sided=False)
        prev = np.roll(soc, 1)
        recon = prev + bu.eff_charge * ch * dt - dis * dt / bu.eff_discharge - bu.aux_mw * dt
        _worst(rep, f"b_soc_continuity:{bu.name}", soc - recon, tol.energy_mwh, "MWh", "SOC must follow the efficiency-adjusted recursion (circular year)")
        _worst(rep, f"b_split:{bu.name}", dis - np.asarray(r["dis_ppa"]) - np.asarray(r["dis_sell"]), tol.power_mw, "MW", "discharge must equal dis_ppa + dis_sell")
        if "re_colocated" in bu.charging_sources and "grid" not in bu.charging_sources and "market" not in bu.charging_sources and len(spec.bess_units) == 1:
            _worst(rep, f"b_re_only:{bu.name}", ch - ch_from_re, tol.power_mw, "MW", "RE-only storage charged more than RE sent to it", two_sided=False)
        if bu.throughput_cap_mwh is not None:
            _worst(rep, f"b_throughput:{bu.name}", np.array([dis.sum() * dt - bu.throughput_cap_mwh]), tol.energy_mwh, "MWh", "throughput cap exceeded", two_sided=False)
        d_sum += np.asarray(r["dis_ppa"])
        s_sum += np.asarray(r["dis_sell"])
    # Market
    buy = np.asarray(dispatch["market"]["buy"], dtype=float)
    buy_ppa = np.asarray(dispatch["market"]["buy_ppa"], dtype=float)
    if spec.market.purchase_enabled:
        _worst(rep, "market_limit", buy - spec.market.purchase_limit_mw, tol.power_mw, "MW", "purchase above limit", two_sided=False)
        ch_market = sum(np.asarray(dispatch["bess"][b.name]["charge_market"]) for b in spec.bess_units) if spec.bess_units else np.zeros(T)
        _worst(rep, "market_split", buy * (1 - spec.market.delivery_loss) - buy_ppa - ch_market, tol.power_mw, "MW", "delivered purchases must equal buy x (1 - loss)")
    else:
        _worst(rep, "market_disabled", np.abs(buy) + np.abs(buy_ppa), tol.power_mw, "MW", "no purchases when the market is disabled", two_sided=False)
    d_sum += buy_ppa
    # Delivered and sold definitions, contracted capacity, interconnection
    _worst(rep, "delivered_definition", delivered - d_sum, tol.power_mw, "MW", "delivered must equal the sum of flows to the PPA")
    _worst(rep, "sold_definition", sold - s_sum, tol.power_mw, "MW", "sold must equal the sum of flows to the market")
    is_peak = np.zeros(T, dtype=bool)
    is_peak[np.asarray(ob.peak_intervals, dtype=int)] = True
    cap = np.where(is_peak, ob.contracted_capacity_mw, ob.contracted_capacity_mw * ob.non_peak_take_fraction)
    _worst(rep, "contracted_capacity", delivered - cap, tol.power_mw, "MW", "delivered above the contracted (scheduled) capacity", two_sided=False)
    _worst(rep, "interconnection", delivered + sold - spec.interconnection_limit_mw, tol.power_mw, "MW", "export above the interconnection limit", two_sided=False)
    # Obligations recomputed
    months = np.asarray(spec.month_of_interval)
    short_month = np.asarray(dispatch["short_month_mwh"], dtype=float)
    monthly_ok = []
    for m in range(1, 13):
        idx = np.flatnonzero(is_peak & (months == m))
        if idx.size == 0:
            continue
        req = ob.peak_availability_floor * ob.contracted_capacity_mw * idx.size * dt
        got = float(delivered[idx].sum() * dt)
        if got + short_month[m - 1] + tol.energy_mwh < req:
            rep.issues.append(Issue("peak_month", req - got - short_month[m - 1], tol.energy_mwh, "MWh", f"month {m}: delivered peak energy plus declared shortfall below the floor"))
        monthly_ok.append(got + 1e-9 >= req)
    rep.checks_run.append("peak_month")
    total = float(delivered.sum() * dt)
    floor_mwh = ob.annual_cuf_floor * ob.contracted_capacity_mw * ob.cuf_hours_per_year
    cap_mwh = ob.annual_cuf_cap * ob.contracted_capacity_mw * ob.cuf_hours_per_year
    short_annual = float(dispatch["short_annual_mwh"])
    if total + short_annual + tol.energy_mwh < floor_mwh:
        rep.issues.append(Issue("annual_floor", floor_mwh - total - short_annual, tol.energy_mwh, "MWh", "annual delivered plus declared shortfall below the CUF floor"))
    if total > cap_mwh + tol.energy_mwh:
        rep.issues.append(Issue("annual_cap", total - cap_mwh, tol.energy_mwh, "MWh", "annual delivered above the CUF cap"))
    rep.checks_run += ["annual_floor", "annual_cap"]
    ext = float(buy_ppa.sum() * dt)
    if ext > ob.external_sourcing_max_fraction * total + tol.energy_mwh:
        rep.issues.append(Issue("external_sourcing", ext - ob.external_sourcing_max_fraction * total, tol.energy_mwh, "MWh", "external sourcing above the allowance"))
    rep.checks_run.append("external_sourcing")
    # Money: recompute the objective
    tau_net = max(0.0, spec.tariff_inr_per_kwh - ob.psm_charge_inr_per_kwh) * KWH_PER_MWH
    sale_price = np.asarray(spec.market.sale_price_inr_per_kwh if spec.market.sale_enabled else spec.merchant_price_inr_per_kwh, dtype=float) - (spec.market.sale_charges_inr_per_kwh if spec.market.sale_enabled else 0.0)
    revenue = total * tau_net + float((sold * sale_price).sum() * dt * KWH_PER_MWH)
    cost = 0.0
    if spec.market.purchase_enabled:
        cost += float((buy * (np.asarray(spec.market.purchase_price_inr_per_kwh) + spec.market.purchase_charges_inr_per_kwh)).sum() * dt * KWH_PER_MWH)
    for u in spec.thermal_units:
        r = dispatch["thermal"][u.name]
        p = np.asarray(r["p"])
        if u.cost_segments:
            segs = sorted(u.cost_segments)
            pmax = u.capacity_mw * (1 - u.aux_fraction) * u.availability
            for i, (start_mw, price) in enumerate(segs):
                width = (segs[i + 1][0] if i + 1 < len(segs) else pmax) - start_mw
                cost += float(np.clip(p - start_mw, 0, width).sum() * dt * price)
        else:
            cost += float(p.sum() * dt * u.variable_cost_inr_per_mwh)
        cost += float(np.asarray(r["start"]).sum() * u.startup_cost_inr + np.asarray(r["stop"]).sum() * u.shutdown_cost_inr)
    penalty = (short_month.sum() + short_annual) * ob.penalty_multiplier * spec.tariff_inr_per_kwh * KWH_PER_MWH
    objective = -revenue + cost + penalty
    rep.objective_recomputed_inr = float(objective)
    rep.objective_solver_inr = solver_objective
    rep.checks_run.append("objective")
    if solver_objective is not None:
        diff = abs(objective - solver_objective)
        if diff > max(tol.money_abs_inr, tol.money_rel * abs(objective)):
            rep.issues.append(Issue("objective", diff, max(tol.money_abs_inr, tol.money_rel * abs(objective)), "INR", "recomputed objective differs from the solver's"))
    rep.compliance = {"peak_ok": all(monthly_ok) if monthly_ok else True, "annual_cuf_ok": total + 1e-9 >= floor_mwh, "annual_cap_ok": total <= cap_mwh + tol.energy_mwh, "external_ok": ext <= ob.external_sourcing_max_fraction * total + tol.energy_mwh, "penalty_mwh": float(short_month.sum() + short_annual)}
    rep.status = "failed" if rep.issues else "certified"
    return rep
