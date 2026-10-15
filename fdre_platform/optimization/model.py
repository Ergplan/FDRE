"""The fixed-tariff dispatch MILP, built directly on HiGHS.

Chronological supply-demand balance at every interval of the year with storage
continuity across the whole horizon (circular year), technology capacity bounds, grid
import/export limits, BESS SOC dynamics with charge and discharge efficiencies, auxiliary
load, throughput and cycle limits, thermal/biomass unit commitment (on/off binaries,
minimum stable generation, ramps, minimum up/down times, start-up and shut-down costs,
fuel energy cap, piecewise variable cost), tender obligations (monthly peak availability
in energy terms with shortfall variables, annual CUF band, external sourcing allowance,
non-peak take fraction), RE-only charging where the tender requires it, exchange purchase
and sale flows at scenario prices, curtailment and merchant surplus.

Objective: at a fixed tariff, minimise -(PPA revenue net of PSM) - (sale revenue)
+ purchase cost + thermal variable and start-up costs + liquidated damages. The tariff is
fixed in each subproblem, so the objective is linear; the outer search varies it.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .spec import DispatchSpec

try:
    import highspy
except ImportError as exc:  # pragma: no cover - highspy is a declared dependency
    raise RuntimeError("highspy is required for the MILP formulation") from exc

INF = float("inf")
KWH_PER_MWH = 1000.0


class _Builder:
    def __init__(self) -> None:
        self.lb: list[np.ndarray] = []
        self.ub: list[np.ndarray] = []
        self.cost: list[np.ndarray] = []
        self.integer: list[np.ndarray] = []
        self.ncol = 0
        self.rows_i: list[np.ndarray] = []
        self.rows_j: list[np.ndarray] = []
        self.rows_v: list[np.ndarray] = []
        self.row_lb: list[float] = []
        self.row_ub: list[float] = []
        self.row_names: list[str] = []

    def vars(self, n: int, lb: Any = 0.0, ub: Any = INF, cost: Any = 0.0, integer: bool = False) -> np.ndarray:
        idx = np.arange(self.ncol, self.ncol + n)
        self.lb.append(np.broadcast_to(np.asarray(lb, dtype=float), (n,)).copy())
        self.ub.append(np.broadcast_to(np.asarray(ub, dtype=float), (n,)).copy())
        self.cost.append(np.broadcast_to(np.asarray(cost, dtype=float), (n,)).copy())
        self.integer.append(np.full(n, integer))
        self.ncol += n
        return idx

    def row(self, cols: list[np.ndarray], coefs: list[Any], lb: float, ub: float, name: str = "") -> int:
        """One row: sum(coef_k * x[cols_k]) in [lb, ub]; cols are index arrays or scalars."""
        r = len(self.row_lb)
        for c, k in zip(cols, coefs, strict=True):
            c = np.atleast_1d(np.asarray(c))
            k = np.broadcast_to(np.asarray(k, dtype=float), c.shape)
            self.rows_i.append(np.full(c.shape, r))
            self.rows_j.append(c)
            self.rows_v.append(k)
        self.row_lb.append(lb)
        self.row_ub.append(ub)
        self.row_names.append(name)
        return r

    def rows_elementwise(self, terms: list[tuple[np.ndarray, Any]], lb: Any, ub: Any, name: str = "") -> np.ndarray:
        """n rows at once: for each t, sum_k coef_k[t] * x[idx_k[t]] in [lb[t], ub[t]]."""
        n = len(terms[0][0])
        base = len(self.row_lb)
        rows = np.arange(base, base + n)
        for idx, coef in terms:
            idx = np.asarray(idx)
            coef = np.broadcast_to(np.asarray(coef, dtype=float), (n,))
            self.rows_i.append(rows)
            self.rows_j.append(idx)
            self.rows_v.append(coef)
        self.row_lb.extend(np.broadcast_to(np.asarray(lb, dtype=float), (n,)).tolist())
        self.row_ub.extend(np.broadcast_to(np.asarray(ub, dtype=float), (n,)).tolist())
        self.row_names.extend([name] * n)
        return rows

    def build(self) -> tuple[Any, int]:
        from scipy.sparse import coo_matrix

        lp = highspy.HighsLp()
        lp.num_col_ = self.ncol
        lp.num_row_ = len(self.row_lb)
        lp.col_cost_ = np.concatenate(self.cost) if self.cost else np.zeros(0)
        lp.col_lower_ = np.concatenate(self.lb) if self.lb else np.zeros(0)
        lp.col_upper_ = np.concatenate(self.ub) if self.ub else np.zeros(0)
        lp.row_lower_ = np.asarray(self.row_lb, dtype=float)
        lp.row_upper_ = np.asarray(self.row_ub, dtype=float)
        i = np.concatenate(self.rows_i) if self.rows_i else np.zeros(0, dtype=int)
        j = np.concatenate(self.rows_j) if self.rows_j else np.zeros(0, dtype=int)
        v = np.concatenate(self.rows_v) if self.rows_v else np.zeros(0)
        a = coo_matrix((v, (i, j)), shape=(lp.num_row_, lp.num_col_)).tocsc()
        a.sum_duplicates()
        lp.a_matrix_.format_ = highspy.MatrixFormat.kColwise
        lp.a_matrix_.start_ = a.indptr.astype(np.int32)
        lp.a_matrix_.index_ = a.indices.astype(np.int32)
        lp.a_matrix_.value_ = a.data.astype(float)
        integ = np.concatenate(self.integer) if self.integer else np.zeros(0, dtype=bool)
        n_bin = int(integ.sum())
        if n_bin:
            lp.integrality_ = [highspy.HighsVarType.kInteger if b else highspy.HighsVarType.kContinuous for b in integ]
        lp.sense_ = highspy.ObjSense.kMinimize
        return lp, n_bin


@dataclass
class Variables:
    re_ppa: dict[str, np.ndarray] = field(default_factory=dict)
    re_ch: dict[str, np.ndarray] = field(default_factory=dict)
    re_sell: dict[str, np.ndarray] = field(default_factory=dict)
    re_curt: dict[str, np.ndarray] = field(default_factory=dict)
    th_p: dict[str, np.ndarray] = field(default_factory=dict)
    th_on: dict[str, np.ndarray] = field(default_factory=dict)
    th_st: dict[str, np.ndarray] = field(default_factory=dict)
    th_sd: dict[str, np.ndarray] = field(default_factory=dict)
    th_ppa: dict[str, np.ndarray] = field(default_factory=dict)
    th_sell: dict[str, np.ndarray] = field(default_factory=dict)
    th_ch: dict[str, np.ndarray] = field(default_factory=dict)
    th_seg: dict[str, list[np.ndarray]] = field(default_factory=dict)
    b_ch: dict[str, np.ndarray] = field(default_factory=dict)
    b_dis: dict[str, np.ndarray] = field(default_factory=dict)
    b_soc: dict[str, np.ndarray] = field(default_factory=dict)
    b_dis_ppa: dict[str, np.ndarray] = field(default_factory=dict)
    b_dis_sell: dict[str, np.ndarray] = field(default_factory=dict)
    b_ch_market: dict[str, np.ndarray] = field(default_factory=dict)
    buy: np.ndarray | None = None
    buy_ppa: np.ndarray | None = None
    delivered: np.ndarray | None = None
    sold: np.ndarray | None = None
    short_month: np.ndarray | None = None
    short_annual: int | None = None


@dataclass
class SolveResult:
    status: str                     # optimal | feasible_time_limit | infeasible | unbounded | failed | cancelled
    solver_status: str
    objective: float | None
    best_bound: float | None
    gap: float | None
    wall_seconds: float
    n_variables: int
    n_constraints: int
    n_binaries: int
    solver: str = "HiGHS"
    solver_version: str = ""
    dispatch: dict[str, Any] = field(default_factory=dict)
    aggregates: dict[str, Any] = field(default_factory=dict)
    options: dict[str, Any] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)


def build(spec: DispatchSpec) -> tuple[_Builder, Variables]:
    b = _Builder()
    v = Variables()
    T = spec.intervals
    dt = spec.dt_hours
    ob = spec.obligations
    tau_net = max(0.0, spec.tariff_inr_per_kwh - ob.psm_charge_inr_per_kwh) * KWH_PER_MWH   # INR per MWh delivered
    penalty = ob.penalty_multiplier * spec.tariff_inr_per_kwh * KWH_PER_MWH
    re_charging = any("re_colocated" in u.charging_sources or "re_contracted" in u.charging_sources for u in spec.bess_units)
    grid_charging = any("grid" in u.charging_sources for u in spec.bess_units)
    market_charging = any("market" in u.charging_sources for u in spec.bess_units) and spec.market.purchase_enabled
    sale_price = np.asarray(spec.market.sale_price_inr_per_kwh if spec.market.sale_enabled else spec.merchant_price_inr_per_kwh, dtype=float)
    sale_price = sale_price - (spec.market.sale_charges_inr_per_kwh if spec.market.sale_enabled else 0.0)
    sale_rev = sale_price * KWH_PER_MWH * dt  # INR per MW sold in one interval
    sale_cap = spec.market.sale_limit_mw if spec.market.sale_enabled else (INF if ob.merchant_sales_allowed else 0.0)
    # Delivered and sold totals
    v.delivered = b.vars(T, 0.0, ob.contracted_capacity_mw, cost=-tau_net * dt)
    v.sold = b.vars(T, 0.0, sale_cap if ob.merchant_sales_allowed or spec.market.sale_enabled else 0.0, cost=-sale_rev)
    # Non-peak take fraction
    is_peak = np.zeros(T, dtype=bool)
    is_peak[np.asarray(ob.peak_intervals, dtype=int)] = True
    if ob.non_peak_take_fraction < 1.0:
        cap = np.where(is_peak, ob.contracted_capacity_mw, ob.contracted_capacity_mw * ob.non_peak_take_fraction)
        b.ub[0] = cap  # delivered upper bound by interval
    delivered_terms: list[tuple[np.ndarray, Any]] = []
    sold_terms: list[tuple[np.ndarray, Any]] = []
    re_ch_terms: dict[str, list[tuple[np.ndarray, Any]]] = {u.name: [] for u in spec.bess_units}
    # RE units
    for u in spec.re_units:
        avail = np.asarray(u.available_mw, dtype=float)
        v.re_ppa[u.name] = b.vars(T, 0.0, avail)
        v.re_sell[u.name] = b.vars(T, 0.0, avail if (ob.merchant_sales_allowed or spec.market.sale_enabled) else 0.0)
        v.re_curt[u.name] = b.vars(T, 0.0, avail if u.curtailable else 0.0)
        terms = [(v.re_ppa[u.name], 1.0), (v.re_sell[u.name], 1.0), (v.re_curt[u.name], 1.0)]
        if re_charging and spec.bess_units:
            v.re_ch[u.name] = b.vars(T, 0.0, avail)
            terms.append((v.re_ch[u.name], 1.0))
            for bu in spec.bess_units:
                if "re_colocated" in bu.charging_sources or "re_contracted" in bu.charging_sources:
                    re_ch_terms[bu.name].append((v.re_ch[u.name], 1.0))
        b.rows_elementwise(terms, avail, avail, f"re_balance:{u.name}")
        delivered_terms.append((v.re_ppa[u.name], 1.0))
        sold_terms.append((v.re_sell[u.name], 1.0))
    # Thermal units
    n_bin = 0
    for u in spec.thermal_units:
        pmax = u.capacity_mw * (1 - u.aux_fraction) * u.availability
        pmin = u.min_stable_mw * (1 - u.aux_fraction) * u.availability
        if not u.eligible:
            pmax = 0.0
        cost_per_mw_interval = u.variable_cost_inr_per_mwh * dt
        v.th_p[u.name] = b.vars(T, 0.0, pmax, cost=cost_per_mw_interval if not u.cost_segments else 0.0)
        v.th_on[u.name] = b.vars(T, 0.0, 1.0, integer=True)
        v.th_st[u.name] = b.vars(T, 0.0, 1.0, cost=u.startup_cost_inr)
        v.th_sd[u.name] = b.vars(T, 0.0, 1.0, cost=u.shutdown_cost_inr)
        v.th_ppa[u.name] = b.vars(T, 0.0, pmax)
        v.th_sell[u.name] = b.vars(T, 0.0, pmax if (ob.merchant_sales_allowed or spec.market.sale_enabled) else 0.0)
        n_bin += T
        split = [(v.th_p[u.name], 1.0), (v.th_ppa[u.name], -1.0), (v.th_sell[u.name], -1.0)]
        if grid_charging and spec.bess_units:
            v.th_ch[u.name] = b.vars(T, 0.0, pmax)
            split.append((v.th_ch[u.name], -1.0))
            for bu in spec.bess_units:
                if "grid" in bu.charging_sources:
                    re_ch_terms[bu.name].append((v.th_ch[u.name], 1.0))
        b.rows_elementwise(split, 0.0, 0.0, f"th_split:{u.name}")
        b.rows_elementwise([(v.th_p[u.name], 1.0), (v.th_on[u.name], -pmax)], -INF, 0.0, f"th_max:{u.name}")
        b.rows_elementwise([(v.th_p[u.name], 1.0), (v.th_on[u.name], -pmin)], 0.0, INF, f"th_min:{u.name}")
        # Logic and ramps for t >= 1 (the first interval's state is free).
        t1 = np.arange(1, T)
        b.rows_elementwise([(v.th_on[u.name][t1], 1.0), (v.th_on[u.name][t1 - 1], -1.0), (v.th_st[u.name][t1], -1.0), (v.th_sd[u.name][t1], 1.0)], 0.0, 0.0, f"th_logic:{u.name}")
        b.rows_elementwise([(v.th_p[u.name][t1], 1.0), (v.th_p[u.name][t1 - 1], -1.0), (v.th_st[u.name][t1], -pmax)], -INF, u.ramp_up_mw_per_interval, f"th_ramp_up:{u.name}")
        b.rows_elementwise([(v.th_p[u.name][t1 - 1], 1.0), (v.th_p[u.name][t1], -1.0), (v.th_sd[u.name][t1], -pmax)], -INF, u.ramp_down_mw_per_interval, f"th_ramp_down:{u.name}")
        for t in range(1, T):
            if u.min_up_intervals > 1:
                k0 = max(1, t - u.min_up_intervals + 1)
                b.row([v.th_st[u.name][k0 : t + 1], v.th_on[u.name][t]], [1.0, -1.0], -INF, 0.0, f"th_minup:{u.name}")
            if u.min_down_intervals > 1:
                k0 = max(1, t - u.min_down_intervals + 1)
                b.row([v.th_sd[u.name][k0 : t + 1], v.th_on[u.name][t]], [1.0, 1.0], -INF, 1.0, f"th_mindown:{u.name}")
        if u.annual_energy_cap_mwh is not None:
            b.row([v.th_p[u.name]], [dt], -INF, u.annual_energy_cap_mwh, f"th_fuel_cap:{u.name}")
        if u.cost_segments:
            # Piecewise: p = sum of segment outputs, each with its own cost and width.
            segs = sorted(u.cost_segments)
            widths = [(segs[i + 1][0] if i + 1 < len(segs) else pmax) - segs[i][0] for i in range(len(segs))]
            seg_vars = []
            for (start_mw, price), width in zip(segs, widths, strict=True):
                sv = b.vars(T, 0.0, max(0.0, width), cost=price * dt)
                seg_vars.append(sv)
            v.th_seg[u.name] = seg_vars
            b.rows_elementwise([(v.th_p[u.name], 1.0)] + [(sv, -1.0) for sv in seg_vars], 0.0, 0.0, f"th_segments:{u.name}")
        delivered_terms.append((v.th_ppa[u.name], 1.0))
        sold_terms.append((v.th_sell[u.name], 1.0))
    # Market purchases
    if spec.market.purchase_enabled:
        price = (np.asarray(spec.market.purchase_price_inr_per_kwh, dtype=float) + spec.market.purchase_charges_inr_per_kwh) * KWH_PER_MWH * dt
        v.buy = b.vars(T, 0.0, spec.market.purchase_limit_mw, cost=price)
        v.buy_ppa = b.vars(T, 0.0, spec.market.purchase_limit_mw)
        terms = [(v.buy, 1.0 - spec.market.delivery_loss), (v.buy_ppa, -1.0)]
        if market_charging:
            for bu in spec.bess_units:
                if "market" in bu.charging_sources:
                    v.b_ch_market[bu.name] = b.vars(T, 0.0, bu.charge_limit_mw)
                    terms.append((v.b_ch_market[bu.name], -1.0))
                    re_ch_terms[bu.name].append((v.b_ch_market[bu.name], 1.0))
        b.rows_elementwise(terms, 0.0, 0.0, "market_split")
        if spec.market.purchase_limit_mwh_per_day:
            per_day = int(round(24 / dt))
            for d in range(T // per_day):
                b.row([v.buy[d * per_day : (d + 1) * per_day]], [dt], -INF, spec.market.purchase_limit_mwh_per_day, "market_daily_cap")
        delivered_terms.append((v.buy_ppa, 1.0))
    # BESS
    for bu in spec.bess_units:
        av = bu.availability
        v.b_ch[bu.name] = b.vars(T, 0.0, bu.charge_limit_mw * av)
        v.b_dis[bu.name] = b.vars(T, 0.0, bu.discharge_limit_mw * av)
        v.b_soc[bu.name] = b.vars(T, 0.0, bu.usable_mwh * av)
        v.b_dis_ppa[bu.name] = b.vars(T, 0.0, bu.discharge_limit_mw * av)
        v.b_dis_sell[bu.name] = b.vars(T, 0.0, bu.discharge_limit_mw * av if (ob.merchant_sales_allowed or spec.market.sale_enabled) else 0.0)
        # Charging sources: the charge equals what the allowed sources send.
        if re_ch_terms[bu.name]:
            b.rows_elementwise([(v.b_ch[bu.name], 1.0)] + [(idx, -c) for idx, c in re_ch_terms[bu.name]], 0.0, 0.0, f"b_sources:{bu.name}")
        else:
            b.ub[len(b.ub) - 5][:] = 0.0  # no allowed source: it cannot charge
        b.rows_elementwise([(v.b_dis[bu.name], 1.0), (v.b_dis_ppa[bu.name], -1.0), (v.b_dis_sell[bu.name], -1.0)], 0.0, 0.0, f"b_split:{bu.name}")
        # SOC continuity, circular year: soc_t - soc_{t-1} - eff_c dt ch_t + dt/eff_d dis_t = -aux dt
        prev = np.roll(np.arange(T), 1)
        b.rows_elementwise([(v.b_soc[bu.name], 1.0), (v.b_soc[bu.name][prev], -1.0), (v.b_ch[bu.name], -bu.eff_charge * dt), (v.b_dis[bu.name], dt / bu.eff_discharge)], -bu.aux_mw * dt, -bu.aux_mw * dt, f"b_soc:{bu.name}")
        # Power rating shared by charge and discharge
        b.rows_elementwise([(v.b_ch[bu.name], 1.0), (v.b_dis[bu.name], 1.0)], -INF, bu.power_mw * av, f"b_power:{bu.name}")
        if bu.throughput_cap_mwh is not None:
            b.row([v.b_dis[bu.name]], [dt], -INF, bu.throughput_cap_mwh, f"b_throughput:{bu.name}")
        if bu.cycles_per_day_limit is not None:
            per_day = int(round(24 / dt))
            for d in range(T // per_day):
                b.row([v.b_dis[bu.name][d * per_day : (d + 1) * per_day]], [dt], -INF, bu.cycles_per_day_limit * bu.usable_mwh, f"b_cycles:{bu.name}")
        delivered_terms.append((v.b_dis_ppa[bu.name], 1.0))
        sold_terms.append((v.b_dis_sell[bu.name], 1.0))
    # Delivered and sold definitions
    b.rows_elementwise([(v.delivered, 1.0)] + [(idx, -c) for idx, c in delivered_terms], 0.0, 0.0, "delivered")
    b.rows_elementwise([(v.sold, 1.0)] + [(idx, -c) for idx, c in sold_terms], 0.0, 0.0, "sold")
    # Interconnection: exports and imports
    b.rows_elementwise([(v.delivered, 1.0), (v.sold, 1.0)], -INF, spec.interconnection_limit_mw, "interconnection_export")
    if v.buy is not None:
        b.rows_elementwise([(v.buy, 1.0)], -INF, spec.interconnection_limit_mw, "interconnection_import")
    # Monthly peak availability in energy terms
    months = np.asarray(spec.month_of_interval)
    v.short_month = b.vars(12, 0.0, INF, cost=penalty)
    for m in range(1, 13):
        idx = np.flatnonzero(is_peak & (months == m))
        if idx.size == 0:
            continue
        req = ob.peak_availability_floor * ob.contracted_capacity_mw * idx.size * dt
        b.row([v.delivered[idx], v.short_month[m - 1]], [dt, 1.0], req, INF, f"peak_month:{m}")
    # Annual CUF band
    v.short_annual = int(b.vars(1, 0.0, INF, cost=penalty)[0])
    floor_mwh = ob.annual_cuf_floor * ob.contracted_capacity_mw * ob.cuf_hours_per_year
    cap_mwh = ob.annual_cuf_cap * ob.contracted_capacity_mw * ob.cuf_hours_per_year
    b.row([v.delivered, np.array([v.short_annual])], [dt, 1.0], floor_mwh, INF, "annual_floor")
    b.row([v.delivered], [dt], -INF, cap_mwh, "annual_cap")
    # External sourcing allowance
    if v.buy_ppa is not None:
        b.row([v.buy_ppa, v.delivered], [dt, -ob.external_sourcing_max_fraction * dt], -INF, 0.0, "external_sourcing")
    # RE share: thermal (non-renewable) delivered energy limited
    if ob.re_share_min_fraction is not None and spec.thermal_units:
        non_re = [v.th_ppa[u.name] for u in spec.thermal_units if not u.renewable]
        if non_re:
            b.row(non_re + [v.delivered], [dt] * len(non_re) + [-(1 - ob.re_share_min_fraction) * dt], -INF, 0.0, "re_share")
    return b, v


def solve(spec: DispatchSpec, *, time_limit_seconds: float = 120.0, mip_rel_gap: float = 0.01, threads: int = 0, cancel_check=None, log: bool = False) -> SolveResult:
    t0 = time.perf_counter()
    builder, v = build(spec)
    lp, n_bin = builder.build()
    h = highspy.Highs()
    h.setOptionValue("output_flag", bool(log))
    h.setOptionValue("time_limit", float(time_limit_seconds))
    h.setOptionValue("mip_rel_gap", float(mip_rel_gap))
    if threads:
        h.setOptionValue("threads", int(threads))
    h.passModel(lp)
    if cancel_check is not None:
        h.setOptionValue("time_limit", float(min(time_limit_seconds, 30.0)))
    h.run()
    status = h.getModelStatus()
    info = h.getInfo()
    name = str(status).split(".")[-1]
    mapped = {
        "kOptimal": "optimal", "kTimeLimit": "feasible_time_limit", "kInfeasible": "infeasible", "kUnboundedOrInfeasible": "infeasible", "kUnbounded": "unbounded",
        "kIterationLimit": "feasible_time_limit", "kInterrupt": "cancelled", "kSolutionLimit": "feasible_time_limit",
    }.get(name, "failed")
    objective = None
    bound = None
    gap = None
    dispatch: dict[str, Any] = {}
    aggregates: dict[str, Any] = {}
    has_solution = info.primal_solution_status == 2 or (mapped == "optimal")
    if mapped in ("optimal", "feasible_time_limit") and has_solution:
        objective = float(info.objective_function_value)
        if n_bin:
            bound = float(info.mip_dual_bound)
            gap = float(info.mip_gap) if np.isfinite(info.mip_gap) else None
        else:
            bound = objective
            gap = 0.0
        x = np.asarray(h.getSolution().col_value, dtype=float)
        dispatch = extract(spec, v, x)
        aggregates = aggregate(spec, dispatch)
    elif mapped == "feasible_time_limit" and not has_solution:
        mapped = "time_limit_no_solution"
    wall = time.perf_counter() - t0
    return SolveResult(
        status=mapped, solver_status=name, objective=objective, best_bound=bound, gap=gap, wall_seconds=round(wall, 3), n_variables=int(lp.num_col_), n_constraints=int(lp.num_row_), n_binaries=n_bin,
        solver_version=".".join(str(p) for p in h.version()) if not isinstance(h.version(), str) else h.version(), dispatch=dispatch, aggregates=aggregates,
        options={"time_limit_seconds": time_limit_seconds, "mip_rel_gap": mip_rel_gap, "threads": threads}, notes=list(spec.notes),
    )


def extract(spec: DispatchSpec, v: Variables, x: np.ndarray) -> dict[str, Any]:
    out: dict[str, Any] = {"delivered_mw": x[v.delivered], "sold_mw": x[v.sold], "short_month_mwh": x[v.short_month] if v.short_month is not None else np.zeros(12), "short_annual_mwh": float(x[v.short_annual]) if v.short_annual is not None else 0.0}
    out["re"] = {u.name: {"ppa": x[v.re_ppa[u.name]], "sell": x[v.re_sell[u.name]], "curtail": x[v.re_curt[u.name]], "charge": x[v.re_ch[u.name]] if u.name in v.re_ch else np.zeros(spec.intervals), "available": np.asarray(u.available_mw)} for u in spec.re_units}
    out["thermal"] = {u.name: {"p": x[v.th_p[u.name]], "on": np.round(x[v.th_on[u.name]]), "start": x[v.th_st[u.name]], "stop": x[v.th_sd[u.name]], "ppa": x[v.th_ppa[u.name]], "sell": x[v.th_sell[u.name]], "charge": x[v.th_ch[u.name]] if u.name in v.th_ch else np.zeros(spec.intervals)} for u in spec.thermal_units}
    out["bess"] = {bu.name: {"charge": x[v.b_ch[bu.name]], "discharge": x[v.b_dis[bu.name]], "soc": x[v.b_soc[bu.name]], "dis_ppa": x[v.b_dis_ppa[bu.name]], "dis_sell": x[v.b_dis_sell[bu.name]], "charge_market": x[v.b_ch_market[bu.name]] if bu.name in v.b_ch_market else np.zeros(spec.intervals)} for bu in spec.bess_units}
    out["market"] = {"buy": x[v.buy] if v.buy is not None else np.zeros(spec.intervals), "buy_ppa": x[v.buy_ppa] if v.buy_ppa is not None else np.zeros(spec.intervals)}
    return out


def aggregate(spec: DispatchSpec, d: dict[str, Any]) -> dict[str, Any]:
    """Annual aggregates for the financial evaluator, in MWh and INR, plus compliance."""
    dt = spec.dt_hours
    ob = spec.obligations
    delivered = float(d["delivered_mw"].sum() * dt)
    sold = float(d["sold_mw"].sum() * dt)
    sale_price = np.asarray(spec.market.sale_price_inr_per_kwh if spec.market.sale_enabled else spec.merchant_price_inr_per_kwh, dtype=float)
    sale_rev = float((d["sold_mw"] * (sale_price - (spec.market.sale_charges_inr_per_kwh if spec.market.sale_enabled else 0.0))).sum() * dt * KWH_PER_MWH)
    buy = float(d["market"]["buy"].sum() * dt)
    buy_cost = 0.0
    if spec.market.purchase_enabled:
        buy_cost = float((d["market"]["buy"] * (np.asarray(spec.market.purchase_price_inr_per_kwh) + spec.market.purchase_charges_inr_per_kwh)).sum() * dt * KWH_PER_MWH)
    th_mwh = {u.name: float(d["thermal"][u.name]["p"].sum() * dt) for u in spec.thermal_units}
    fuel_cost = sum(th_mwh[u.name] * u.fuel_cost_inr_per_mwh for u in spec.thermal_units)
    var_cost = sum(th_mwh[u.name] * u.variable_cost_inr_per_mwh for u in spec.thermal_units)
    start_cost = sum(float(d["thermal"][u.name]["start"].sum()) * u.startup_cost_inr + float(d["thermal"][u.name]["stop"].sum()) * u.shutdown_cost_inr for u in spec.thermal_units)
    is_peak = np.zeros(spec.intervals, dtype=bool)
    is_peak[np.asarray(ob.peak_intervals, dtype=int)] = True
    months = np.asarray(spec.month_of_interval)
    monthly = []
    for m in range(1, 13):
        idx = np.flatnonzero(is_peak & (months == m))
        if idx.size == 0:
            continue
        req = ob.contracted_capacity_mw * idx.size * dt
        got = float(d["delivered_mw"][idx].sum() * dt)
        monthly.append({"month": m, "peak_energy_required_mwh": req, "peak_energy_delivered_mwh": got, "availability": got / req if req else 1.0, "compliant": got / req + 1e-9 >= ob.peak_availability_floor if req else True, "shortfall_mwh": float(d["short_month_mwh"][m - 1])})
    penalty_mwh = float(d["short_month_mwh"].sum() + d["short_annual_mwh"])
    re_available = sum(float(np.asarray(u.available_mw).sum() * dt) for u in spec.re_units)
    re_curtailed = sum(float(d["re"][u.name]["curtail"].sum() * dt) for u in spec.re_units)
    re_to_ppa = sum(float(d["re"][u.name]["ppa"].sum() * dt) for u in spec.re_units)
    bess_dis = sum(float(d["bess"][b.name]["discharge"].sum() * dt) for b in spec.bess_units)
    bess_ch = sum(float(d["bess"][b.name]["charge"].sum() * dt) for b in spec.bess_units)
    bess_dis_ppa = sum(float(d["bess"][b.name]["dis_ppa"].sum() * dt) for b in spec.bess_units)
    re_charged = sum(float(d["re"][u.name]["charge"].sum() * dt) for u in spec.re_units)
    external = float(d["market"]["buy_ppa"].sum() * dt)
    th_to_ppa = sum(float(d["thermal"][u.name]["ppa"].sum() * dt) for u in spec.thermal_units)
    bio_to_ppa = sum(float(d["thermal"][u.name]["ppa"].sum() * dt) for u in spec.thermal_units if u.renewable)
    # Renewable attribution of storage: share of charge that came from RE.
    re_share_of_charge = (re_charged / bess_ch) if bess_ch > 1e-9 else 1.0
    renewable_delivered = re_to_ppa + bio_to_ppa + bess_dis_ppa * re_share_of_charge + (external if spec.market.purchase_counts_as_renewable else 0.0)
    cuf = delivered / (ob.contracted_capacity_mw * ob.cuf_hours_per_year) if ob.contracted_capacity_mw else 0.0
    return {
        "ppa_mwh": delivered, "merchant_mwh": sold, "merchant_revenue_inr": sale_rev, "iex_purchase_mwh": buy, "iex_purchase_cost_inr": buy_cost, "external_green_mwh": external,
        "thermal_mwh": th_mwh, "fuel_cost_inr": fuel_cost, "thermal_variable_cost_inr": var_cost, "startup_cost_inr": start_cost,
        "total_penalty_mwh": penalty_mwh, "peak_shortfall_mwh": float(d["short_month_mwh"].sum()), "annual_shortfall_mwh": float(d["short_annual_mwh"]),
        "re_available_mwh": re_available, "re_curtailed_mwh": re_curtailed, "re_to_ppa_mwh": re_to_ppa, "re_charged_mwh": re_charged, "bess_charge_mwh": bess_ch, "bess_discharge_mwh": bess_dis, "bess_discharge_to_ppa_mwh": bess_dis_ppa,
        "thermal_to_ppa_mwh": th_to_ppa, "renewable_delivered_mwh": renewable_delivered, "renewable_share": (renewable_delivered / delivered) if delivered else None,
        "annual_cuf": cuf, "annual_cuf_ok": cuf + 1e-9 >= ob.annual_cuf_floor, "monthly": monthly, "peak_ok": all(m["compliant"] for m in monthly), "min_monthly_peak_availability": min((m["availability"] for m in monthly), default=1.0),
        "external_share": (external / delivered) if delivered else 0.0,
    }
