"""Round-the-clock (RTC) plant sizing as a linear programme solved with HiGHS.

Chooses solar MW, wind MW and battery MW (battery MWh follows the discharge duration, or is
free within a duration window) that minimise the 25-year tariff at the target equity IRR,
subject to the delivery-for-requirement (DFR) floor in every modelled year.

The model mirrors the browser engine (web/src/rtc/engine.js):

* Hourly (8,760 h) dispatch for a set of representative PPA years. Each year applies its own
  solar/wind degradation, battery fade after augmentation and demand growth. The years always
  include year 1 and every "worst" year (no other year is worse on every factor at once), so
  meeting the DFR in them means meeting it in all years. ``years="all"`` models all 25.
* Delivery is capped at min(demand, plant MW). Surplus charges the battery, is exported
  within spare plant capacity plus extra export MW (if sold) or is curtailed.
* Battery: power limit, SoC window scaled by the year's capacity factor, round-trip
  efficiency split evenly between charge and discharge, starting SoC as in the engine.
* Objective: the tariff T that makes equity NPV zero at the target equity IRR. With tax
  taken as linear (losses credited in the year rather than carried forward), equity NPV is
  linear in the design, so T = cost(x) / energy(x) is a linear-fractional programme. It is
  solved exactly by Dinkelbach iterations: min cost(x) − λ·energy(x), λ ← cost/energy, with
  HiGHS re-solving from the previous basis each time.

Energy in years between two representative years is interpolated linearly. The browser
engine re-prices the HiGHS design (and its neighbours) with the exact financial model, so
tax losses carried forward and DSCR effects are accounted for in the final answer.
"""
from __future__ import annotations

import math
import time
from typing import Any

import numpy as np
import scipy.sparse as sp

try:  # optional at import time so the rest of the engine still starts without it
    import highspy
except ImportError:  # pragma: no cover - reported by solve()
    highspy = None

HOURS = 8760
MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
MONTH_OF_HOUR = np.repeat(np.arange(12), [d * 24 for d in MONTH_DAYS])
RS_CR_PER_MWH_AT_1RS = 1e-4  # 1 MWh at Rs 1/kWh = Rs 1,000 = 1e-4 crore
VAR_KEYS = ("solarMw", "windMw", "bessMw", "bessMwh")


class LpInputError(ValueError):
    pass


# ----------------------------------------------------------------------------- years

def year_factors(year: int, fin: dict, bess: dict) -> dict:
    """Same as yearFactors() in engine.js."""
    solar = (1 - float(fin.get("solarDegradation") or 0)) ** (year - 1)
    wind = (1 - float(fin.get("windDegradation") or 0)) ** (year - 1)
    demand = (1 + float(fin.get("demandGrowth") or 0)) ** (year - 1)
    deg = float(bess.get("annualDegradation") or 0)
    aug = bess.get("augmentation", "annual")
    b = 1.0
    if aug == "none":
        b = max(0.4, 1 - deg * (year - 1))
    elif aug == "oneTime":
        ay = int(bess.get("augmentationYear") or 0)
        since = year - ay if year >= ay else year - 1
        b = max(0.4, 1 - deg * since)
    return {"solarFactor": solar, "windFactor": wind, "bessFactor": b, "demandFactor": demand}


def representative_years(fin: dict, bess: dict, mode: str = "representative") -> list[int]:
    n = int(fin.get("years") or 25)
    if mode == "all":
        return list(range(1, n + 1))
    f = {y: year_factors(y, fin, bess) for y in range(1, n + 1)}

    def worse_or_equal(a: dict, b: dict) -> bool:  # a is at least as hard as b on every factor
        return (a["solarFactor"] <= b["solarFactor"] + 1e-12 and a["windFactor"] <= b["windFactor"] + 1e-12
                and a["bessFactor"] <= b["bessFactor"] + 1e-12 and a["demandFactor"] >= b["demandFactor"] - 1e-12)

    worst = []
    for y in range(1, n + 1):
        dominated = any(o != y and worse_or_equal(f[o], f[y]) and not worse_or_equal(f[y], f[o]) for o in f)
        if not dominated:
            worst.append(y)
    # of years with identical factors keep the last (latest cost weight is lowest; any works)
    uniq: dict[tuple, int] = {}
    for y in worst:
        uniq[tuple(round(v, 12) for v in f[y].values())] = y
    if len({tuple(round(v, 12) for v in f[y].values()) for y in f}) == 1:
        return [1]  # no ageing and no growth: every year is the same
    years = {1, n, *uniq.values()}
    if bess.get("augmentation") == "oneTime":
        ay = int(bess.get("augmentationYear") or 0)
        if 1 < ay <= n:
            years.update({ay - 1, ay})
    return sorted(years)


def interpolation_weights(rep: list[int], n: int) -> np.ndarray:
    """w[y-1, j]: share of year y's energy taken from representative year rep[j]."""
    w = np.zeros((n, len(rep)))
    for y in range(1, n + 1):
        if y in rep:
            w[y - 1, rep.index(y)] = 1.0
            continue
        if y > rep[-1]:  # after the last modelled year: same as it
            w[y - 1, len(rep) - 1] = 1.0
            continue
        hi = next(j for j, r in enumerate(rep) if r > y)
        lo = hi - 1
        th = (y - rep[lo]) / (rep[hi] - rep[lo])
        w[y - 1, lo] = 1 - th
        w[y - 1, hi] = th
    return w


# ----------------------------------------------------------------------------- finance

def _crf(rate: float, n: int) -> float:
    if rate <= 0:
        return 1 / n
    f = (1 + rate) ** n
    return rate * f / (f - 1)


def _debt_per_crore(fin: dict, n: int) -> tuple[np.ndarray, np.ndarray, float]:
    """Interest and principal by year per crore of capex, and debt left after year n."""
    d = float(fin["debtFraction"])
    i = float(fin["interestRate"])
    tenor = min(n, max(1, round(float(fin["tenorYears"]))))
    annuity = d * _crf(i, tenor)
    interest = np.zeros(n + 1)
    principal = np.zeros(n + 1)
    debt = d
    for y in range(1, n + 1):
        interest[y] = debt * i
        if y <= tenor and debt > 1e-12:
            principal[y] = min(debt, annuity - interest[y]) if fin.get("repayment") == "annuity" else min(debt, d / tenor)
        debt -= principal[y]
    return interest, principal, debt


def _dep_capex(fin: dict, n: int) -> np.ndarray:
    """Tax depreciation of the initial capex by year, per crore (engine.js cashflows())."""
    salvage = float(fin.get("salvagePct") or 0)
    w = float(fin.get("wdvRate") or 0)
    life = max(1, int(fin.get("bookLifeYears") or n))
    wdv = fin.get("taxDepreciation") == "wdv"
    return np.array([0.0] + [w * (1 - w) ** (y - 1) if wdv else ((1 - salvage) / life if y <= life else 0.0) for y in range(1, n + 1)])


def _dep_aug(fin: dict, n: int, a: int) -> np.ndarray:
    """Tax depreciation by year of one crore of augmentation spent in year a."""
    w = float(fin.get("wdvRate") or 0)
    wdv = fin.get("taxDepreciation") == "wdv"
    out = np.zeros(n + 1)
    for y in range(a, n + 1):
        out[y] = w * (1 - w) ** (y - a) if wdv else 1 / max(1, n - a + 1)
    return out


def tax_timing(fin: dict, taxable_by_year: np.ndarray | None) -> np.ndarray:
    """Year in which a marginal change to year y's taxable income is taxed (0 = never).

    Losses are carried forward (engine.js), so a deduction in a loss year only saves tax once
    the loss pool is used up. Without a reference (None) every year is taxed in the year.
    """
    n = int(fin.get("years") or 25)
    z = np.arange(n + 1)
    if taxable_by_year is None:
        return z
    pays = np.zeros(n + 2, bool)
    pool = 0.0
    for y in range(1, n + 1):
        t = float(taxable_by_year[y])
        if t > 0:
            use = min(pool, t)
            pool -= use
            pays[y] = t - use > 1e-9
        else:
            pool -= t
    nxt = 0
    for y in range(n, 0, -1):
        if pays[y]:
            nxt = y
        z[y] = nxt
    return z


def tariff_weights(fin: dict, taxed_in: np.ndarray | None = None) -> dict:
    """Equity NPV at the target IRR, per crore of each cash item, linear in the design.

    NPV = Σ rev[y]·Revenue_y − Σ opex[y]·Opex_y − Σ aug[y]·AugCapex_y − capex·Capex
    (the cash flow structure of cashflows() in engine.js). ``taxed_in[y]`` is the year in
    which year y's taxable income is taxed (see tax_timing); by default the same year.
    """
    n = int(fin.get("years") or 25)
    k = float(fin["targetEquityIrr"])
    tau = float(fin["taxRate"])
    d = float(fin["debtFraction"])
    days = float(fin.get("receivableDays") or 0) / 365
    salvage = float(fin.get("salvagePct") or 0)
    v = np.array([(1 + k) ** -y for y in range(0, n + 2)])  # v[y]
    z = np.arange(n + 1) if taxed_in is None else taxed_in
    vt = np.array([v[z[y]] if z[y] > 0 else 0.0 for y in range(n + 1)])  # discount of year y's tax
    vt[0] = 0.0

    rev = np.zeros(n + 1)
    opex = np.zeros(n + 1)
    aug = np.zeros(n + 1)
    for y in range(1, n + 1):
        opex[y] = v[y] - tau * vt[y]
        rev[y] = v[y] - tau * vt[y] - (days * (v[y] - v[y + 1]) if y < n else 0.0)

    interest, principal, debt_left = _debt_per_crore(fin, n)
    capex = (1 - d) + float(v[1:n + 1] @ (interest[1:] + principal[1:])) - tau * float(vt[1:] @ interest[1:])
    capex += v[n] * (debt_left - salvage)
    capex -= tau * float(vt[1:] @ _dep_capex(fin, n)[1:])
    for a in range(1, n + 1):
        aug[a] = v[a] - tau * float(vt[1:] @ _dep_aug(fin, n, a)[1:])
    return {"rev": rev, "opex": opex, "aug": aug, "capex": capex, "years": n, "taxedIn": z}


def reference_taxable(fin: dict, costs: dict, bess: dict, sizes: dict, delivered_mwh: np.ndarray,
                      export_mwh: np.ndarray, tariff: float, biomass_mwh: np.ndarray | None = None) -> np.ndarray:
    """Taxable income by year (before loss set-off) for a design, as in engine.js."""
    n = int(fin.get("years") or 25)
    y = np.arange(1, n + 1)
    bio_mw = float(sizes.get("biomassMw") or 0)
    hard = (sizes["solarMw"] * costs["solarCrPerMw"] + sizes["windMw"] * costs["windCrPerMw"]
            + sizes["bessMwh"] * costs["bessCrPerMwh"] + sizes["bessMw"] * float(costs.get("bessPcsCrPerMw") or 0)
            + bio_mw * float(costs.get("biomassCrPerMw") or 0)
            + float(costs.get("evacuationCr") or 0))
    capex = hard * (1 + float(costs.get("preopPct") or 0))
    esc = (1 + float(fin.get("omEscalation") or 0)) ** (y - 1)
    om = (sizes["solarMw"] * fin["solarOmLakhPerMw"] + sizes["windMw"] * fin["windOmLakhPerMw"]
          + sizes["bessMwh"] * fin["bessOmLakhPerMwh"] + bio_mw * float(fin.get("biomassOmLakhPerMw") or 0)) / 100 * esc
    opex = om + hard * float(fin.get("insurancePct") or 0) + float(fin.get("otherFixedCr") or 0) * esc
    if biomass_mwh is not None:  # fuel for the biomass plant, Rs/kWh generated
        fuel_esc = (1 + float(fin.get("biomassFuelEscalation") or 0)) ** (y - 1)
        opex = opex + biomass_mwh * float(fin.get("biomassFuelRsPerKwh") or 0) * fuel_esc * RS_CR_PER_MWH_AT_1RS
    trf = tariff * (1 + float(fin.get("tariffEscalation") or 0)) ** (y - 1)
    sell = float(fin.get("surplusPrice") or 0) if fin.get("sellSurplus") else 0.0
    revenue = delivered_mwh * trf * RS_CR_PER_MWH_AT_1RS + export_mwh * sell * RS_CR_PER_MWH_AT_1RS
    interest, _, _ = _debt_per_crore(fin, n)
    aug = aug_cost_per_mwh(costs, bess, n) * sizes["bessMwh"]
    dep = capex * _dep_capex(fin, n)
    for a in range(1, n + 1):
        if aug[a]:
            dep = dep + aug[a] * _dep_aug(fin, n, a)
    out = np.zeros(n + 1)
    out[1:] = revenue - opex - interest[1:] * capex - dep[1:]
    return out


def aug_cost_per_mwh(costs: dict, bess: dict, n: int) -> np.ndarray:
    """Augmentation capex (Rs cr) per MWh of installed battery energy, by year (engine.js)."""
    out = np.zeros(n + 1)
    deg = float(bess.get("annualDegradation") or 0)
    price = lambda y: float(costs["bessCrPerMwh"]) * (1 - float(bess.get("costDeclinePct") or 0)) ** (y - 1)
    if not deg:
        return out
    if bess.get("augmentation") == "annual":
        for y in range(2, n + 1):
            out[y] = deg * price(y)
    elif bess.get("augmentation") == "oneTime":
        y = int(bess.get("augmentationYear") or 0)
        if 1 < y <= n:
            out[y] = min(0.6, deg * (y - 1)) * price(y)
    return out


# ----------------------------------------------------------------------------- model

def _series(values: Any, name: str) -> np.ndarray:
    arr = np.asarray(values, dtype=float)
    if arr.shape != (HOURS,) or not np.all(np.isfinite(arr)):
        raise LpInputError(f"{name} must be {HOURS} finite hourly values")
    return arr


def _bounds(spec: dict | None, default_max: float) -> tuple[float, float, bool]:
    spec = spec or {}
    if spec.get("locked"):
        val = max(0.0, float(spec.get("value") or 0))
        return val, val, True
    lo = max(0.0, float(spec.get("min") or 0))
    hi = max(lo, float(spec.get("max") if spec.get("max") is not None else default_max))
    return lo, hi, False


def solve(payload: dict, on_log=None, on_progress=None, log_limit: int = 1500) -> dict:
    """Build and solve the sizing LP. ``payload`` follows the browser engine's names.

    ``on_log(line)`` receives every log line as it happens (HiGHS output included) and
    ``on_progress(dict)`` each Dinkelbach iteration, for streaming to the browser.
    """
    started = time.perf_counter()
    lines: list[dict] = []

    def note(stage: str, msg: str) -> None:
        line = {"t": round((time.perf_counter() - started) * 1000), "stage": stage, "msg": msg}
        if len(lines) < log_limit:
            lines.append(line)
        if on_log:
            on_log(line)

    if highspy is None:
        raise LpInputError("HiGHS (highspy) is not installed in the engine")

    ctx = payload.get("ctx") or {}
    demand = _series(ctx.get("demand"), "demand")
    solar_cf = _series(ctx.get("solarCf"), "solarCf")
    wind_cf = _series(ctx.get("windCf"), "windCf")
    plant = float(ctx.get("plantMw") or 0)
    if plant <= 0:
        raise LpInputError("plantMw must be positive")
    loss = 1 - float(ctx.get("lossPct") or 0)
    sell = bool(ctx.get("sellSurplus"))
    extra = max(0.0, float(ctx.get("extraExportMw") or 0))
    bess = payload.get("bess") or {}
    costs = payload.get("costs") or {}
    fin = payload.get("fin") or {}
    dfr_target = float(payload.get("dfrTarget") or 0)
    monthly = payload.get("dfrBasis") == "monthly"
    variables = payload.get("vars") or {}
    mode = payload.get("years") or "representative"
    n = int(fin.get("years") or 25)

    eta = math.sqrt(min(1.0, max(0.5, float(bess.get("rte") or 0.87))))
    min_soc = float(bess.get("minSoc") or 0)
    max_soc = float(bess.get("maxSoc") or 1)
    init_soc = float(bess.get("initSoc") if bess.get("initSoc") is not None else 0.5)
    duration = float(bess.get("durationH") or 0) or None

    s_lo, s_hi, _ = _bounds(variables.get("solarMw"), 5 * plant)
    w_lo, w_hi, _ = _bounds(variables.get("windMw"), 5 * plant)
    p_lo, p_hi, _ = _bounds(variables.get("bessMw"), 2 * plant)
    e_lo, e_hi, _ = _bounds(variables.get("bessMwh"), 12 * plant)

    # Optional biomass plant (Tender to Bid): a dispatchable generator with its own size column
    # and an hourly output column per modelled year. Absent from Round-the-clock payloads.
    bio = payload.get("biomass") if isinstance(payload.get("biomass"), dict) else None
    if bio is not None and variables.get("biomassMw") is not None:
        bm_lo, bm_hi, _ = _bounds(variables.get("biomassMw"), plant)
        has_bio = bm_hi > 0
    else:
        bm_lo = bm_hi = 0.0
        has_bio = False
    if has_bio:
        bio_avail = min(1.0, max(0.0, float(bio.get("availability") if bio.get("availability") is not None else 0.9)))
        bio_min = min(bio_avail, max(0.0, float(bio.get("minLoad") or 0)))
        bio_plf = min(bio_avail, max(0.0, float(bio.get("maxPlf") if bio.get("maxPlf") is not None else bio_avail)))
        fuel = max(0.0, float(fin.get("biomassFuelRsPerKwh") or 0))
        fuel_esc = (1 + float(fin.get("biomassFuelEscalation") or 0)) ** (np.arange(1, n + 1) - 1)

    # Optional supply rules (Tender to Bid): each is a floor on delivered ÷ demand over all hours
    # or over the peak hours (peakMask), for the year or for every month. When given they replace
    # the single DFR floor.
    rules = []
    for item in payload.get("compliance") or []:
        target = float(item.get("target") or 0)
        if target <= 0:
            continue
        hours = item.get("hours") or "all"
        if hours not in ("all", "peak"):
            raise LpInputError("compliance hours must be 'all' or 'peak'")
        basis = item.get("basis") or "annual"
        if basis not in ("annual", "monthly"):
            raise LpInputError("compliance basis must be 'annual' or 'monthly'")
        rules.append({"id": str(item.get("id") or f"rule{len(rules) + 1}"), "label": str(item.get("label") or ""),
                      "target": min(1.0, target), "hours": hours, "basis": basis})
    peak_mask = None
    if any(r["hours"] == "peak" for r in rules):
        peak_mask = _series(payload.get("peakMask"), "peakMask") > 0.5
        if not peak_mask.any():
            raise LpInputError("peakMask marks no peak hours")

    rep = representative_years(fin, bess, mode)
    weights = interpolation_weights(rep, n)
    aug_mwh = aug_cost_per_mwh(costs, bess, n)
    years_arr = np.arange(1, n + 1)
    tariff_esc = (1 + float(fin.get("tariffEscalation") or 0)) ** (years_arr - 1)
    om_esc = (1 + float(fin.get("omEscalation") or 0)) ** (years_arr - 1)
    surplus_price = float(fin.get("surplusPrice") or 0) if sell else 0.0
    preop = 1 + float(costs.get("preopPct") or 0)
    ins = float(fin.get("insurancePct") or 0)
    evac = float(costs.get("evacuationCr") or 0)

    # ---- columns: S, W, P, [E], then per year: dir, ch, dis, soc, [ex]
    free_e = duration is None
    n_size = 4 if free_e else 3
    BM_COL = n_size  # biomass MW, after the battery columns (only when has_bio)
    if has_bio:
        n_size += 1
    blocks = 5 if sell else 4
    BIO_BLOCK = blocks  # per-year biomass output block, after dir, ch, dis, soc, [ex]
    if has_bio:
        blocks += 1
    per_year = blocks * HOURS
    n_col = n_size + per_year * len(rep)
    col_lo = np.zeros(n_col)
    col_hi = np.full(n_col, np.inf)
    col_lo[:3] = [s_lo, w_lo, p_lo]
    col_hi[:3] = [s_hi, w_hi, p_hi]
    if free_e:  # with a fixed duration the MWh bounds do not apply (as in the engine)
        col_lo[3], col_hi[3] = e_lo, e_hi
    if has_bio:
        col_lo[BM_COL], col_hi[BM_COL] = bm_lo, bm_hi
    E_COL = 3 if free_e else 2
    e_scale = 1.0 if free_e else duration  # battery MWh = e_scale * column E_COL

    rows_i: list[np.ndarray] = []
    rows_j: list[np.ndarray] = []
    rows_v: list[np.ndarray] = []
    row_lo: list[np.ndarray] = []
    row_hi: list[np.ndarray] = []
    n_row = 0
    t = np.arange(HOURS)
    ones = np.ones(HOURS)
    deliver_cols: list[np.ndarray] = []  # (dir, dis) columns per year, for reporting
    dfr_rows: list[tuple[int, int, int, str]] = []  # (row, year, month or -1, rule id or "dfr")
    demand_by_year = []
    bio_cols: list[np.ndarray] = []  # biomass output columns per modelled year

    def add(r: np.ndarray, c: np.ndarray, val: np.ndarray) -> None:
        rows_i.append(r)
        rows_j.append(c)
        rows_v.append(val)

    for yi, year in enumerate(rep):
        f = year_factors(year, fin, bess)
        base = n_size + yi * per_year
        c_dir, c_ch, c_dis, c_soc = (base + b * HOURS + t for b in range(4))
        c_ex = base + 4 * HOURS + t if sell else None
        c_bio = base + BIO_BLOCK * HOURS + t if has_bio else None
        if has_bio:
            bio_cols.append(c_bio)
        dem = demand * f["demandFactor"]
        target = np.minimum(dem, plant)
        demand_by_year.append(dem)
        deliver_cols.append((c_dir, c_dis))
        sgen = solar_cf * f["solarFactor"] * loss
        wgen = wind_cf * f["windFactor"] * loss
        bf = f["bessFactor"]

        # generation: dir + ch + ex - s*S - w*W [- biomass] <= 0
        r = n_row + t
        add(r, c_dir, ones); add(r, c_ch, ones)
        if sell:
            add(r, c_ex, ones)
        add(r, np.zeros(HOURS, int), -sgen); add(r, np.ones(HOURS, int), -wgen)
        if has_bio:
            add(r, c_bio, -ones)
        row_lo.append(np.full(HOURS, -np.inf)); row_hi.append(np.zeros(HOURS))
        n_row += HOURS
        if has_bio:
            # biomass output within availability x MW, and above the minimum stable load
            r = n_row + t
            add(r, c_bio, ones); add(r, np.full(HOURS, BM_COL), np.full(HOURS, -bio_avail))
            row_lo.append(np.full(HOURS, -np.inf)); row_hi.append(np.zeros(HOURS))
            n_row += HOURS
            if bio_min > 0:
                r = n_row + t
                add(r, c_bio, ones); add(r, np.full(HOURS, BM_COL), np.full(HOURS, -bio_min))
                row_lo.append(np.zeros(HOURS)); row_hi.append(np.full(HOURS, np.inf))
                n_row += HOURS
            # yearly fuel limit: output <= PLF x 8760 x MW (in GWh for scaling)
            add(np.full(HOURS, n_row), c_bio, np.full(HOURS, 1e-3))
            add(np.array([n_row]), np.array([BM_COL]), np.array([-1e-3 * bio_plf * HOURS]))
            row_lo.append(np.array([-np.inf])); row_hi.append(np.array([0.0]))
            n_row += 1
        # delivery: dir + dis <= min(demand, plant); with sales the export shares the connection
        r = n_row + t
        add(r, c_dir, ones); add(r, c_dis, ones)
        row_lo.append(np.full(HOURS, -np.inf)); row_hi.append(target)
        n_row += HOURS
        if sell:
            r = n_row + t
            add(r, c_dir, ones); add(r, c_dis, ones); add(r, c_ex, ones)
            row_lo.append(np.full(HOURS, -np.inf)); row_hi.append(np.full(HOURS, plant + extra))
            n_row += HOURS
        # battery power: ch - P <= 0, dis - P <= 0
        for c in (c_ch, c_dis):
            r = n_row + t
            add(r, c, ones); add(r, np.full(HOURS, 2), -ones)
            row_lo.append(np.full(HOURS, -np.inf)); row_hi.append(np.zeros(HOURS))
            n_row += HOURS
        # state of charge above the floor, u = soc - minSoc*E*bf >= 0 (a bound, not a row):
        # u_t - u_{t-1} - eta*ch + dis/eta = 0, with u_{-1} = (initSoc - minSoc) * E * bf
        r = n_row + t
        add(r, c_soc, ones); add(r[1:], c_soc[:-1], -ones[1:])
        add(r, c_ch, np.full(HOURS, -eta)); add(r, c_dis, np.full(HOURS, 1 / eta))
        add(np.array([n_row]), np.array([E_COL]), np.array([-min(max(init_soc - min_soc, 0.0), max_soc - min_soc) * bf * e_scale]))
        row_lo.append(np.zeros(HOURS)); row_hi.append(np.zeros(HOURS))
        n_row += HOURS
        # u <= (maxSoc - minSoc) * E * bf
        r = n_row + t
        add(r, c_soc, ones); add(r, np.full(HOURS, E_COL), np.full(HOURS, -(max_soc - min_soc) * bf * e_scale))
        row_lo.append(np.full(HOURS, -np.inf)); row_hi.append(np.zeros(HOURS))
        n_row += HOURS
        # DFR: delivered >= target share of demand (per year, or per month); with supply rules,
        # one such floor per rule over its hours
        floors = rules or [{"id": "dfr", "target": dfr_target, "hours": "all", "basis": "monthly" if monthly else "annual"}]
        for rule in floors:
            hours_mask = peak_mask if rule["hours"] == "peak" else np.ones(HOURS, bool)
            groups = [(m, MONTH_OF_HOUR == m) for m in range(12)] if rule["basis"] == "monthly" else [(-1, np.ones(HOURS, bool))]
            for m, mask in groups:
                idx = t[mask & hours_mask]
                if idx.size == 0:
                    continue
                add(np.full(idx.size, n_row), c_dir[idx], np.full(idx.size, 1e-3))  # GWh, for scaling
                add(np.full(idx.size, n_row), c_dis[idx], np.full(idx.size, 1e-3))
                row_lo.append(np.array([1e-3 * rule["target"] * dem[idx].sum()])); row_hi.append(np.array([np.inf]))
                dfr_rows.append((n_row, year, m, rule["id"]))
                n_row += 1

    if free_e:  # duration window: minDur*P <= E <= maxDur*P
        min_d = float(bess.get("minDurationH") or 0)
        max_d = float(bess.get("maxDurationH") or 24)
        add(np.array([n_row, n_row]), np.array([3, 2]), np.array([1.0, -min_d]))
        row_lo.append(np.array([0.0])); row_hi.append(np.array([np.inf]))
        n_row += 1
        add(np.array([n_row, n_row]), np.array([3, 2]), np.array([1.0, -max_d]))
        row_lo.append(np.array([-np.inf])); row_hi.append(np.array([0.0]))
        n_row += 1

    A = sp.csc_matrix((np.concatenate(rows_v), (np.concatenate(rows_i), np.concatenate(rows_j))), shape=(n_row, n_col))
    A.sum_duplicates()
    rlo = np.concatenate(row_lo)
    rhi = np.concatenate(row_hi)

    ex_cols = [n_size + yi * per_year + 4 * HOURS + t for yi in range(len(rep))] if sell else []

    def objective(tw: dict) -> tuple[np.ndarray, np.ndarray, float, np.ndarray]:
        """cost(x) (Rs cr, PV at the equity IRR) and energy(x) (Rs cr per Rs/kWh of tariff)."""
        rev_w = tw["rev"][1:]
        opex_w = tw["opex"][1:]
        energy_w = RS_CR_PER_MWH_AT_1RS * (weights.T @ (rev_w * tariff_esc))
        surplus_w = RS_CR_PER_MWH_AT_1RS * surplus_price * (weights.T @ rev_w)
        pv_om = float(opex_w @ om_esc)
        pv_flat = float(opex_w.sum())

        def size_cost(capex_cr_per_unit: float, om_lakh_per_unit: float) -> float:
            return tw["capex"] * capex_cr_per_unit * preop + pv_om * om_lakh_per_unit / 100 + pv_flat * capex_cr_per_unit * ins

        cost_e = size_cost(float(costs["bessCrPerMwh"]), float(fin.get("bessOmLakhPerMwh") or 0)) + float(tw["aug"][1:] @ aug_mwh[1:])
        cost_vec = np.zeros(n_col)
        cost_vec[0] = size_cost(float(costs["solarCrPerMw"]), float(fin.get("solarOmLakhPerMw") or 0))
        cost_vec[1] = size_cost(float(costs["windCrPerMw"]), float(fin.get("windOmLakhPerMw") or 0))
        cost_vec[2] = size_cost(float(costs.get("bessPcsCrPerMw") or 0), 0.0)
        if free_e:
            cost_vec[3] = cost_e
        else:
            cost_vec[2] += cost_e * duration
        if has_bio:
            cost_vec[BM_COL] = size_cost(float(costs.get("biomassCrPerMw") or 0), float(fin.get("biomassOmLakhPerMw") or 0))
            # fuel per MWh generated in each modelled year, carried to the years it stands for
            fuel_w = RS_CR_PER_MWH_AT_1RS * fuel * (weights.T @ (opex_w * fuel_esc))
            for yi, c_bio in enumerate(bio_cols):
                cost_vec[c_bio] = fuel_w[yi]
        energy_vec = np.zeros(n_col)
        for yi, (c_dir, c_dis) in enumerate(deliver_cols):
            energy_vec[c_dir] = energy_w[yi]
            energy_vec[c_dis] = energy_w[yi]
            if sell:
                cost_vec[ex_cols[yi]] = -surplus_w[yi]
        const = tw["capex"] * evac * preop + pv_flat * evac * ins + pv_om * float(fin.get("otherFixedCr") or 0)
        return cost_vec, energy_vec, const, energy_w

    def sizes_of(x: np.ndarray) -> dict:
        out = {"solarMw": float(x[0]), "windMw": float(x[1]), "bessMw": float(x[2]), "bessMwh": float(x[E_COL] * e_scale)}
        if has_bio:
            out["biomassMw"] = float(x[BM_COL])
        return out

    def yearly(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Delivered and exported MWh in every PPA year (interpolated between modelled years)."""
        dl = np.array([x[c_dir].sum() + x[c_dis].sum() for c_dir, c_dis in deliver_cols])
        ex = np.array([x[c].sum() for c in ex_cols]) if sell else np.zeros(len(rep))
        return weights @ dl, weights @ ex

    def yearly_biomass(x: np.ndarray) -> np.ndarray | None:
        """Biomass MWh generated in every PPA year (interpolated), or None without biomass."""
        if not has_bio:
            return None
        return weights @ np.array([x[c].sum() for c in bio_cols])

    def describe(z: dict) -> str:
        text = f"solar {z['solarMw']:.1f} MW, wind {z['windMw']:.1f} MW, "
        if has_bio:
            text += f"biomass {z['biomassMw']:.1f} MW, "
        return text + f"BESS {z['bessMw']:.1f} MW / {z['bessMwh']:.1f} MWh"

    build_s = time.perf_counter() - started
    note("highs", f"HiGHS {highspy.Highs().version()} · years modelled: {', '.join(map(str, rep))}"
         f"{' (all years)' if mode == 'all' else ' (year 1, the years that bind the DFR, and augmentation years; the energy of other years is interpolated)'}")
    note("highs", f"LP: {n_col:,} variables, {n_row:,} constraints, {A.nnz:,} non-zeros · built in {build_s:.2f} s")
    note("highs", "Objective: the 25-year tariff at the target equity IRR. It is a ratio (cost ÷ energy), "
                  "solved exactly by Dinkelbach iterations: each is one HiGHS LP, min cost − λ·energy, then λ ← cost ÷ energy")

    # energy bounds over all feasible designs, for the optimality certificate
    def energy_floor(dem: np.ndarray) -> float:
        """Least delivered MWh any feasible design has in a year: the largest the floors imply."""
        if not rules:
            return dfr_target * dem.sum()
        best = 0.0
        for rule in rules:
            hours_mask = peak_mask if rule["hours"] == "peak" else np.ones(HOURS, bool)
            best = max(best, rule["target"] * dem[hours_mask].sum())
        return best

    floor_mwh = np.array([energy_floor(d) for d in demand_by_year])
    cap_mwh = np.array([np.minimum(d, plant).sum() for d in demand_by_year])

    h = highspy.Highs()
    h.setOptionValue("output_flag", True)
    h.setOptionValue("log_to_console", False)
    h.setOptionValue("time_limit", float(payload.get("timeLimitS") or 600))
    # first solve: interior point + crossover (fast on this structure, and leaves a basis);
    # later iterations only change the objective, so primal simplex restarts from that basis
    user_opts = payload.get("highsOptions") or {}
    h.setOptionValue("solver", "ipm")
    h.setOptionValue("run_crossover", "on")
    for key, val in user_opts.items():
        h.setOptionValue(key, val)
    h.cbLogging.subscribe(lambda e: note("highs-log", e.message.rstrip()) if e.message.strip() else None)

    seed = payload.get("seed") or {}
    lam = float(payload.get("tariffGuess") or seed.get("tariff") or 5.0)
    if seed.get("sizes") and seed.get("deliveredMwh"):
        ss = seed["sizes"]
        taxable = reference_taxable(fin, costs, bess, ss, np.asarray(seed["deliveredMwh"], float),
                                    np.asarray(seed.get("exportMwh") or np.zeros(n), float), lam)
        taxed_in = tax_timing(fin, taxable)
        note("highs", f"Start: λ ₹{lam:.4f}/kWh and tax timing from the screening design "
                      f"(solar {ss['solarMw']:.0f} MW, wind {ss['windMw']:.0f} MW, BESS {ss['bessMw']:.0f} MW)")
    else:
        taxed_in = tax_timing(fin, None)
        note("highs", f"Start: λ ₹{lam:.4f}/kWh, tax paid in the year it arises (refined after the first solve)")

    def describe_timing(z: np.ndarray) -> str:
        paid = [y for y in range(1, n + 1) if z[y] == y]
        return f"tax paid from year {paid[0]}" if paid and paid == list(range(paid[0], n + 1)) else (
            f"tax paid in years {', '.join(map(str, paid))}" if paid else "no tax paid in the PPA term")

    cost_vec, energy_vec, cost_const, energy_w = objective(tariff_weights(fin, taxed_in))
    lp = highspy.HighsLp()
    lp.num_col_ = n_col
    lp.num_row_ = n_row
    lp.col_cost_ = cost_vec - lam * energy_vec
    lp.col_lower_ = col_lo
    lp.col_upper_ = col_hi
    lp.row_lower_ = rlo
    lp.row_upper_ = rhi
    lp.a_matrix_.format_ = highspy.MatrixFormat.kColwise
    lp.a_matrix_.start_ = A.indptr
    lp.a_matrix_.index_ = A.indices
    lp.a_matrix_.value_ = A.data
    h.passModel(lp)

    gap_tol = float(payload.get("gapTol") or 0.002)
    iterations = []
    x = None
    status_text = ""
    lower = -math.inf
    all_cols = np.arange(n_col, dtype=np.int32)
    for it in range(1, int(payload.get("maxIterations") or 8) + 1):
        if it > 1:
            cost_vec, energy_vec, cost_const, energy_w = objective(tariff_weights(fin, taxed_in))
            h.changeColsCost(n_col, all_cols, cost_vec - lam * energy_vec)
            if "solver" not in user_opts:
                h.setOptionValue("solver", "simplex")
                h.setOptionValue("simplex_strategy", 4)
        note("highs", f"Dinkelbach iteration {it}: solving at λ ₹{lam:.4f}/kWh ({describe_timing(taxed_in)})")
        if on_progress:
            on_progress({"iteration": it, "lambda": lam})
        t_it = time.perf_counter()
        h.run()
        status = h.getModelStatus()
        status_text = h.modelStatusToString(status)
        info = h.getInfo()
        if status != highspy.HighsModelStatus.kOptimal:
            note("highs", f"Iteration {it}: HiGHS stopped with status '{status_text}'")
            if status == highspy.HighsModelStatus.kInfeasible:
                note("highs", "No design within the size ranges meets the DFR in every modelled year: widen the ranges or lower the DFR")
            break
        x = np.asarray(h.getSolution().col_value)
        cost = float(cost_vec @ x) + cost_const
        energy = float(energy_vec @ x)
        ratio = cost / energy if energy > 0 else math.inf
        f_val = cost - lam * energy
        # certificate: every feasible design has cost - λ·energy >= f_val, and energy between the
        # DFR floor and full delivery, so no design can have a tariff below `lower`
        e_bound = float(energy_w @ (floor_mwh if f_val <= 0 else cap_mwh))
        lower = lam + f_val / e_bound if e_bound > 0 else -math.inf
        z_old = taxed_in
        dl, ex = yearly(x)
        taxed_in = tax_timing(fin, reference_taxable(fin, costs, bess, sizes_of(x), dl, ex, ratio, yearly_biomass(x)))
        timing_same = bool(np.array_equal(z_old, taxed_in))
        z = sizes_of(x)
        iterations.append({
            "iteration": it, "lambda": lam, "tariff": ratio, "lowerBound": lower,
            "simplexIterations": int(info.simplex_iteration_count), "ipmIterations": int(info.ipm_iteration_count),
            "seconds": round(time.perf_counter() - t_it, 2), "sizes": z,
        })
        note("highs", f"Iteration {it} done in {time.perf_counter() - t_it:.1f} s ({info.simplex_iteration_count:,} simplex"
                      f"{f' + {info.ipm_iteration_count} IPM' if info.ipm_iteration_count else ''} iterations): "
                      f"{describe(z)} "
                      f"→ tariff ₹{ratio:.4f}/kWh; proven lower bound ₹{lower:.4f}/kWh (gap ₹{ratio - lower:.4f})"
                      f"{'' if timing_same else '; tax timing updated'}")
        if on_progress:
            on_progress({"iteration": it, "lambda": lam, "tariff": ratio, "lowerBound": lower, "sizes": z})
        lam = ratio
        if ratio - lower <= gap_tol and timing_same:
            break

    # reporting: DFR per modelled year, curtailment and the DFR shadow price
    def rule_outcome(rule: dict, delivered: np.ndarray, dem: np.ndarray) -> dict:
        hours_mask = peak_mask if rule["hours"] == "peak" else np.ones(HOURS, bool)
        if rule["basis"] == "monthly":
            shares = [float(delivered[(MONTH_OF_HOUR == m) & hours_mask].sum() / max(1e-9, dem[(MONTH_OF_HOUR == m) & hours_mask].sum()))
                      for m in range(12) if ((MONTH_OF_HOUR == m) & hours_mask).any()]
            achieved = min(shares)
        else:
            achieved = float(delivered[hours_mask].sum() / max(1e-9, dem[hours_mask].sum()))
        return {"id": rule["id"], "label": rule["label"], "target": rule["target"], "achieved": achieved,
                "met": achieved >= rule["target"] - 1e-6}

    if x is None:
        raise LpInputError(f"HiGHS found no design: {status_text}. No design within the size ranges meets the supply "
                           "rules in every modelled year; widen the size ranges or check the rules")
    duals = np.asarray(h.getSolution().row_dual) if h.getSolution().dual_valid else None
    year_rows = []
    for yi, year in enumerate(rep):
        c_dir, c_dis = deliver_cols[yi]
        delivered = x[c_dir] + x[c_dis]
        dem = demand_by_year[yi]
        monthly_dfr = [float(delivered[MONTH_OF_HOUR == m].sum() / max(1e-9, dem[MONTH_OF_HOUR == m].sum())) for m in range(12)]
        base = n_size + yi * per_year
        row = {
            "year": year,
            "dfr": float(delivered.sum() / dem.sum()),
            "minMonthlyDfr": min(monthly_dfr),
            "deliveredMu": float(delivered.sum() / 1000),
            "exportMu": float(x[base + 4 * HOURS + t].sum() / 1000) if sell else 0.0,
        }
        if has_bio:
            row["biomassMu"] = float(x[bio_cols[yi]].sum() / 1000)
        if rules:
            row["rules"] = [rule_outcome(rule, delivered, dem) for rule in rules]
        year_rows.append(row)
    dfr_price = None
    if duals is not None:
        # tariff change for +1 percentage point of DFR in every binding row
        bump = 0.0
        for row, year, m, _rule in dfr_rows:
            dem = demand_by_year[rep.index(year)]
            share = dem.sum() if m < 0 else dem[MONTH_OF_HOUR == m].sum()
            bump += abs(duals[row]) * 1e-3 * 0.01 * share  # row is in GWh
        energy = float(energy_vec @ x)
        dfr_price = bump / energy if energy > 0 else None
        binding = [f"year {y}{'' if m < 0 else ' ' + str(m + 1)}{'' if rid == 'dfr' else ' (' + rid + ')'}"
                   for row, y, m, rid in dfr_rows if abs(duals[row]) > 1e-9]
        if binding:
            note("highs", f"DFR binds in {', '.join(binding)}; +1 percentage point of DFR would add ≈ ₹{dfr_price:.4f}/kWh to the tariff")

    sizes = sizes_of(x)
    seconds = time.perf_counter() - started
    note("highs", f"Optimal after {len(iterations)} Dinkelbach iteration{'s' if len(iterations) != 1 else ''} in {seconds:.1f} s: "
                  f"{describe(sizes)} "
                  f"· 25-year tariff ₹{lam:.4f}/kWh (no design can be below ₹{lower:.4f}/kWh)")
    result = {
        "ok": True,
        "status": status_text,
        "sizes": sizes,
        "tariff": lam,
        "lowerBound": lower,
        "iterations": iterations,
        "years": rep,
        "perYear": year_rows,
        "dfrPricePerPoint": dfr_price,
        "model": {"columns": n_col, "rows": n_row, "nonzeros": int(A.nnz), "mode": mode},
        "seconds": round(seconds, 2),
        "log": lines,
    }
    if payload.get("returnLifetime"):
        # every PPA year (interpolated between modelled years), for the browser's financial model
        dl, ex = yearly(x)
        bio_y = yearly_biomass(x)
        result["lifetime"] = [
            {
                "year": y,
                "demandMwh": float(demand.sum() * year_factors(y, fin, bess)["demandFactor"]),
                "deliveredMwh": float(dl[y - 1]),
                "exportMwh": float(ex[y - 1]),
                "biomassMwh": float(bio_y[y - 1]) if bio_y is not None else 0.0,
            }
            for y in range(1, n + 1)
        ]
    if payload.get("returnHourly"):
        # hour-by-hour dispatch of the first modelled year (year 1)
        f = year_factors(rep[0], fin, bess)
        base = n_size
        c_dir, c_ch, c_dis, c_soc = (base + b * HOURS + t for b in range(4))
        e_mwh = float(x[E_COL] * e_scale)
        sgen = solar_cf * f["solarFactor"] * loss * sizes["solarMw"]
        wgen = wind_cf * f["windFactor"] * loss * sizes["windMw"]
        bgen = x[bio_cols[0]] if has_bio else np.zeros(HOURS)
        exp = x[base + 4 * HOURS + t] if sell else np.zeros(HOURS)
        curtail = np.maximum(0.0, sgen + wgen + bgen - x[c_dir] - x[c_ch] - exp)
        soc = (x[c_soc] + min_soc * e_mwh * f["bessFactor"]) / e_mwh if e_mwh > 1e-9 else np.zeros(HOURS)
        r2 = lambda a: np.round(np.asarray(a, float), 2).tolist()
        result["hourly"] = {
            "year": rep[0],
            "demand": r2(demand_by_year[0]),
            "solar": r2(sgen), "wind": r2(wgen), "biomass": r2(bgen),
            "direct": r2(x[c_dir]), "charge": r2(x[c_ch]), "discharge": r2(x[c_dis]),
            "export": r2(exp), "curtail": r2(curtail), "soc": np.round(soc, 4).tolist(),
        }
    return result
