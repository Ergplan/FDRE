"""Fifteen-minute dispatch of a sized Tender-to-Bid plant, for every year of the PPA.

The sizing LP (fdre_rtc_lp.solve) chooses the plant in hourly steps over representative years.
This module takes the sizes it chose and dispatches that plant in 15-minute time blocks (96 a
day, the scheduling block of the Indian Grid Code) for each PPA year, one HiGHS LP per year:

* biomass and other dispatchable plants (hydro, thermal) stay at or above their technical
  minimum in every block, and change by at most their ramp rate per block (ramp in %/min x 15);
* the battery charges from renewable output only (RE-RTC tenders: "Charges through RE only"),
  within its power and energy, and never charges and discharges in the same block;
* the tender's supply floors (annual, monthly, peak hours) are applied as in the sizing; a floor
  the plant cannot meet in a year is reported with its shortfall instead of failing the run;
* the schedule to the procurer is kept smooth: among dispatches of equal value, the one with the
  least change in delivery from block to block;
* each year uses that year's solar and wind degradation and battery capacity.

Solar and wind profiles are hourly. Each hour is split into four 15-minute values along the
hour's trend (half the difference between the next and the previous hour), keeping the hour's
energy exactly and every value within [0, peak]; demand and market prices are the hour's value
in each of its blocks.

The objective is the sizing LP's at fixed sizes: PPA revenue at the bid tariff, plus market
sales (worth at most just under the tariff when the PPA comes first), minus fuel and energy
costs, minus a large penalty per kWh of floor shortfall and a negligible cost per MWh of battery
throughput (which breaks ties that would otherwise cycle the battery for nothing).
"""

from __future__ import annotations

import csv
import io
import json
import math
import os
import re
import tempfile
import threading
import time
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable

import numpy as np
import scipy.sparse as sp

import fdre_rtc_lp as RLP

try:
    import highspy
except ImportError:  # pragma: no cover - reported to the caller
    highspy = None

BLOCKS_PER_HOUR = 4
BLOCKS = RLP.HOURS * BLOCKS_PER_HOUR  # 35,040 a year
DT = 1 / BLOCKS_PER_HOUR  # hours per block
HOUR_OF_BLOCK = np.repeat(np.arange(RLP.HOURS), BLOCKS_PER_HOUR)
MONTH_OF_BLOCK = RLP.MONTH_OF_HOUR[HOUR_OF_BLOCK]
HOUR_OF_DAY_BLOCK = RLP.HOUR_OF_DAY[HOUR_OF_BLOCK]
SHORTFALL_PENALTY = 20.0  # x the tariff, per kWh short of a floor
THROUGHPUT_COST = 1e-3  # Rs/kWh charged or discharged: a tie-breaker only
SMOOTH_COST = 1e-3  # Rs/kWh per MW of change in delivery from one block to the next: a tie-breaker only
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


class DispatchError(ValueError):
    pass


def split_hourly(values: np.ndarray, peak: float | None = None) -> np.ndarray:
    """Four 15-minute values per hour that follow the hour's trend and average to the hour's value.

    Within hour h the blocks are v + s x (-3, -1, 1, 3)/8, with s the hour's slope (half the change
    from the previous to the next hour), limited so that every block stays within [0, peak].
    """
    v = np.asarray(values, float)
    top = float(peak if peak is not None else max(v.max(initial=0.0), 0.0))
    slope = (np.r_[v[1:], v[-1]] - np.r_[v[0], v[:-1]]) / 2
    room = np.maximum(0.0, np.minimum(v, top - v)) * 8 / 3
    slope = np.clip(slope, -room, room)
    blocks = v[:, None] + slope[:, None] * (np.array([-3.0, -1.0, 1.0, 3.0]) / 8)[None, :]
    return np.clip(blocks, 0.0, max(top, 0.0)).reshape(-1)  # the clip only removes rounding


def _inputs(payload: dict) -> dict:
    """The sizing request's inputs, parsed as fdre_rtc_lp.solve parses them."""
    ctx = payload.get("ctx") or {}
    plant = float(ctx.get("plantMw") or 0)
    if plant <= 0:
        raise DispatchError("plantMw must be positive")
    fin = payload.get("fin") or {}
    bess = payload.get("bess") or {}
    sell = bool(ctx.get("sellSurplus"))
    rules = []
    for item in payload.get("compliance") or []:
        target = float(item.get("target") or 0)
        if target > 0:
            rules.append({"id": str(item.get("id") or f"rule{len(rules) + 1}"), "label": str(item.get("label") or ""),
                          "target": min(1.0, target), "hours": item.get("hours") or "all", "basis": item.get("basis") or "annual"})
    if not rules:
        target = float(payload.get("dfrTarget") or 0)
        if target > 0:
            rules.append({"id": "dfr", "label": "Supply floor", "target": target, "hours": "all",
                          "basis": "monthly" if payload.get("dfrBasis") == "monthly" else "annual"})
    peak_mask = RLP._series(payload["peakMask"], "peakMask") > 0.5 if payload.get("peakMask") is not None else None
    bio = payload.get("biomass") if isinstance(payload.get("biomass"), dict) else None
    plants = []
    for item in payload.get("plants") or []:
        pid = str(item.get("id") or "")
        if not re.fullmatch(r"[a-z][a-zA-Z0-9]{0,30}", pid) or pid in ("solar", "wind", "bess", "biomass"):
            raise DispatchError(f"plant id {pid!r} is not allowed")
        avail = min(1.0, max(0.0, float(item.get("availability") if item.get("availability") is not None else 1.0)))
        monthly_cuf = item.get("monthlyCuf")
        plants.append({
            "id": pid, "green": bool(item.get("green")), "avail": avail,
            "min": min(avail, max(0.0, float(item.get("minLoad") or 0))),
            "cuf": min(avail, max(0.0, float(item["cuf"]))) if item.get("cuf") is not None else None,
            "monthlyCuf": [min(avail, max(0.0, float(v))) for v in monthly_cuf] if monthly_cuf else None,
            "variable": max(0.0, float(item.get("energyRsPerKwh") or 0)) + max(0.0, float(item.get("recRsPerKwh") or 0)),
            "escalation": float(item.get("escalation") or 0),
            "ramp": min(1.0, max(0.0, float(item["rampPerHour"]))) if item.get("rampPerHour") is not None else None,
        })
    return {
        "plant": plant, "fin": fin, "bess": bess, "sell": sell, "rules": rules, "peak_mask": peak_mask,
        "demand": RLP._series(ctx.get("demand"), "demand"),
        "solar_cf": RLP._series(ctx.get("solarCf"), "solarCf"),
        "wind_cf": RLP._series(ctx.get("windCf"), "windCf"),
        "loss": 1 - float(ctx.get("lossPct") or 0),
        "extra": max(0.0, float(ctx.get("extraExportMw") or 0)),
        "price": RLP._series(ctx["surplusPrice"], "surplusPrice") if sell and ctx.get("surplusPrice") is not None else None,
        "flat_price": float(fin.get("surplusPrice") or 0) if sell else 0.0,
        "sale_cap": RLP._series(ctx["surplusCapMw"], "surplusCapMw") if sell and ctx.get("surplusCapMw") is not None else None,
        "ppa_first": bool(payload.get("ppaFirst")) and sell,
        "solar_only": sell and payload.get("exportSources") == "solar",
        "bio": bio, "plants": plants,
        "green_min": float(payload.get("greenShareMin") or 0),
    }


def _rule_groups(rule: dict, peak_mask_blocks: np.ndarray | None) -> list[tuple[int, np.ndarray]]:
    """(month or -1, block mask) of each floor of a rule, as fdre_rtc_lp applies it per hour."""
    months = range(12) if rule["basis"] == "monthly" else [-1]
    in_month = lambda m: (MONTH_OF_BLOCK == m) if m >= 0 else np.ones(BLOCKS, bool)  # noqa: E731
    if rule["hours"] == "any":
        cand = peak_mask_blocks if peak_mask_blocks is not None else np.ones(BLOCKS, bool)
        return [(m, in_month(m) & (HOUR_OF_DAY_BLOCK == h) & cand) for m in months for h in sorted(set(HOUR_OF_DAY_BLOCK[cand].tolist()))]
    hours = peak_mask_blocks if rule["hours"] == "peak" else np.ones(BLOCKS, bool)
    return [(m, in_month(m) & hours) for m in months]


def _build(inp: dict, sizes: dict, tariff: float, year: int) -> dict:
    """The year's LP: the matrix is the same every year (sizes are fixed); costs, bounds and
    right-hand sides carry the year's degradation and escalation."""
    fin, bess = inp["fin"], inp["bess"]
    f = RLP.year_factors(year, fin, bess)
    plant = inp["plant"]
    S = float(sizes.get("solarMw") or 0)
    W = float(sizes.get("windMw") or 0)
    P = float(sizes.get("bessMw") or 0)
    E = float(sizes.get("bessMwh") or 0)
    BM = float(sizes.get("biomassMw") or 0) if inp["bio"] is not None else 0.0
    eta = math.sqrt(min(1.0, max(0.5, float(bess.get("rte") or 0.87))))
    min_soc = float(bess.get("minSoc") or 0)
    max_soc = float(bess.get("maxSoc") or 1)
    init_soc = float(bess.get("initSoc") if bess.get("initSoc") is not None else 0.5)
    bf = f["bessFactor"]
    span = max(0.0, (max_soc - min_soc) * E * bf)

    dem = np.repeat(inp["demand"] * f["demandFactor"], BLOCKS_PER_HOUR)
    target = np.minimum(dem, plant)
    sgen = S * split_hourly(inp["solar_cf"], 1.0 if inp["solar_cf"].max(initial=0) <= 1 else None) * f["solarFactor"] * inp["loss"]
    wgen = W * split_hourly(inp["wind_cf"], 1.0 if inp["wind_cf"].max(initial=0) <= 1 else None) * f["windFactor"] * inp["loss"]
    ren = sgen + wgen
    peak_blocks = np.repeat(inp["peak_mask"], BLOCKS_PER_HOUR) if inp["peak_mask"] is not None else None
    lam = tariff * (1 + float(fin.get("tariffEscalation") or 0)) ** (year - 1)

    # ---- columns, each a block of BLOCKS: dir, ch, dis, u (SoC above the floor), [ex], [bio], [plants]
    names = ["dir", "ch", "dis", "u"] + (["ex"] if inp["sell"] else []) + (["bio"] if BM > 0 else [])
    pl_live = [pl for pl in inp["plants"] if float(sizes.get(f"{pl['id']}Mw") or 0) > 0]
    names += [f"pl:{pl['id']}" for pl in pl_live]
    col = {name: i * BLOCKS + np.arange(BLOCKS) for i, name in enumerate(names)}
    n_col = len(names) * BLOCKS
    lo = np.zeros(n_col)
    hi = np.full(n_col, np.inf)
    cost = np.zeros(n_col)
    hi[col["ch"]] = P
    hi[col["dis"]] = P
    hi[col["u"]] = span
    b = np.arange(BLOCKS)
    rows_i, rows_j, rows_v, rlo, rhi = [], [], [], [], []
    n_row = 0

    def add_rows(cols_coefs: list[tuple[np.ndarray, Any]], low: np.ndarray | float, high: np.ndarray | float, count: int) -> int:
        nonlocal n_row
        r = n_row + np.arange(count)
        for cols, coef in cols_coefs:
            rows_i.append(r)
            rows_j.append(np.asarray(cols))
            rows_v.append(np.broadcast_to(np.asarray(coef, float), (count,)).copy())
        rlo.append(np.broadcast_to(np.asarray(low, float), (count,)).copy())
        rhi.append(np.broadcast_to(np.asarray(high, float), (count,)).copy())
        n_row += count
        return r[0]

    def add_one(cols: np.ndarray, coefs: np.ndarray, low: float, high: float) -> int:
        nonlocal n_row
        rows_i.append(np.full(len(cols), n_row))
        rows_j.append(np.asarray(cols))
        rows_v.append(np.asarray(coefs, float))
        rlo.append(np.array([low]))
        rhi.append(np.array([high]))
        n_row += 1
        return n_row - 1

    def ramp(cols: np.ndarray, per_block: float) -> None:
        k = BLOCKS - 1
        add_rows([(cols[1:], 1.0), (cols[:-1], -1.0)], -per_block, per_block, k)

    # dispatchable plants: technical minimum and availability per block, ramp per block, energy limits
    if BM > 0:
        bio = inp["bio"]
        avail = min(1.0, max(0.0, float(bio.get("availability") if bio.get("availability") is not None else 0.9)))
        bmin = min(avail, max(0.0, float(bio.get("minLoad") or 0)))
        plf = min(avail, max(0.0, float(bio.get("maxPlf") if bio.get("maxPlf") is not None else avail)))
        lo[col["bio"]], hi[col["bio"]] = bmin * BM, avail * BM
        if bio.get("rampPerHour") is not None and float(bio["rampPerHour"]) < 1.0:
            ramp(col["bio"], max(0.0, float(bio["rampPerHour"])) / BLOCKS_PER_HOUR * BM)
        add_one(col["bio"], np.full(BLOCKS, DT * 1e-3), -np.inf, 1e-3 * plf * RLP.HOURS * BM)
        fuel = max(0.0, float(inp["fin"].get("biomassFuelRsPerKwh") or 0)) * (1 + float(inp["fin"].get("biomassFuelEscalation") or 0)) ** (year - 1)
        cost[col["bio"]] = fuel * DT
    for pl in pl_live:
        mw = float(sizes[f"{pl['id']}Mw"])
        c = col[f"pl:{pl['id']}"]
        lo[c], hi[c] = pl["min"] * mw, pl["avail"] * mw
        if pl["ramp"] is not None and pl["ramp"] < 1.0:
            ramp(c, pl["ramp"] / BLOCKS_PER_HOUR * mw)
        groups = [(MONTH_OF_BLOCK == m, pl["monthlyCuf"][m]) for m in range(12)] if pl["monthlyCuf"] else (
            [(np.ones(BLOCKS, bool), pl["cuf"])] if pl["cuf"] is not None and pl["cuf"] < pl["avail"] else [])
        for mask, share in groups:
            idx = b[mask]
            add_one(c[idx], np.full(idx.size, DT * 1e-3), -np.inf, 1e-3 * share * idx.size * DT * mw)
        cost[c] = pl["variable"] * (1 + pl["escalation"]) ** (year - 1) * DT

    gen_terms = [(col["bio"], -1.0)] if BM > 0 else []
    gen_terms += [(col[f"pl:{pl['id']}"], -1.0) for pl in pl_live]
    green_terms = ([(col["bio"], -1.0)] if BM > 0 else []) + [(col[f"pl:{pl['id']}"], -1.0) for pl in pl_live if pl["green"]]
    # generation: dir + ch + ex <= solar + wind + dispatchable output
    add_rows([(col["dir"], 1.0), (col["ch"], 1.0)] + ([(col["ex"], 1.0)] if inp["sell"] else []) + gen_terms, -np.inf, ren, BLOCKS)
    # the battery charges from renewable output only (needed only when a non-RE plant is in the bid)
    if any(not pl["green"] for pl in pl_live):
        add_rows([(col["ch"], 1.0)] + green_terms, -np.inf, ren, BLOCKS)
    # delivery to the PPA within the contract, and the connection shared with sales
    add_rows([(col["dir"], 1.0), (col["dis"], 1.0)], -np.inf, target, BLOCKS)
    if inp["sell"]:
        add_rows([(col["dir"], 1.0), (col["dis"], 1.0), (col["ex"], 1.0)], -np.inf, plant + inp["extra"], BLOCKS)
        if inp["solar_only"]:
            hi[col["ex"]] = sgen
        elif any(not pl["green"] for pl in pl_live):
            add_rows([(col["ex"], 1.0)] + green_terms, -np.inf, ren, BLOCKS)
        if inp["sale_cap"] is not None:
            hi[col["ex"]] = np.minimum(hi[col["ex"]], np.repeat(np.maximum(0.0, inp["sale_cap"]), BLOCKS_PER_HOUR))
    # state of charge: u_b - u_(b-1) - eta*dt*ch + dt/eta*dis = 0, u_(-1) = (initSoc - minSoc) x E
    u0 = min(max(init_soc - min_soc, 0.0), max_soc - min_soc) * E * bf
    rhs = np.zeros(BLOCKS)
    rhs[0] = u0
    add_rows([(col["u"], 1.0), (col["ch"], -eta * DT), (col["dis"], DT / eta)], rhs, rhs, BLOCKS)
    rows_i.append(n_row - BLOCKS + np.arange(1, BLOCKS))
    rows_j.append(col["u"][:-1])
    rows_v.append(np.full(BLOCKS - 1, -1.0))
    # green share over the year: non-RE output <= (1 - greenShareMin) x delivered
    non_green = [pl for pl in pl_live if not pl["green"]]
    if non_green and inp["green_min"] > 0:
        cols = np.concatenate([col[f"pl:{pl['id']}"] for pl in non_green] + [col["dir"], col["dis"]])
        coefs = np.concatenate([np.full(BLOCKS * len(non_green), DT * 1e-3), np.full(2 * BLOCKS, -DT * 1e-3 * (1 - inp["green_min"]))])
        add_one(cols, coefs, -np.inf, 0.0)
    # supply floors, each with a shortfall column (MWh) so a floor the plant cannot meet is measured
    floor_rows = []
    for rule in inp["rules"]:
        for m, mask in _rule_groups(rule, peak_blocks):
            idx = b[mask]
            if idx.size == 0:
                continue
            floor_rows.append({"rule": rule["id"], "month": m, "mask": mask, "need": rule["target"] * dem[idx].sum() * DT})
    n_short = len(floor_rows)
    short0 = n_col
    n_col += n_short
    lo = np.r_[lo, np.zeros(n_short)]
    hi = np.r_[hi, np.full(n_short, np.inf)]
    cost = np.r_[cost, np.full(n_short, SHORTFALL_PENALTY * max(lam, 1.0))]
    for k, fr in enumerate(floor_rows):
        idx = b[fr["mask"]]
        add_one(np.r_[col["dir"][idx], col["dis"][idx], short0 + k],
                np.r_[np.full(2 * idx.size, DT * 1e-3), 1e-3], 1e-3 * fr["need"], np.inf)
    # a smooth schedule: delivery may move from block to block (up - down columns) at a negligible
    # cost, so energy the floors and revenue do not place is spread evenly, not in alternate blocks
    k = BLOCKS - 1
    up0 = n_col
    n_col += 2 * k
    lo = np.r_[lo, np.zeros(2 * k)]
    hi = np.r_[hi, np.full(2 * k, np.inf)]
    cost = np.r_[cost, np.full(2 * k, SMOOTH_COST * DT)]
    add_rows([(col["dir"][1:], 1.0), (col["dis"][1:], 1.0), (col["dir"][:-1], -1.0), (col["dis"][:-1], -1.0),
              (up0 + np.arange(k), -1.0), (up0 + k + np.arange(k), 1.0)], 0.0, 0.0, k)

    # objective (minimise, Rs thousand = MWh x Rs/kWh): costs - revenue
    cost[col["dir"]] -= lam * DT
    cost[col["dis"]] -= lam * DT
    cost[col["ch"]] += THROUGHPUT_COST * DT
    cost[col["dis"]] += THROUGHPUT_COST * DT
    price_b = None
    if inp["sell"]:
        esc = (1 + float(fin.get("surplusEscalation") or 0)) ** (year - 1)
        price_b = (np.repeat(inp["price"], BLOCKS_PER_HOUR) if inp["price"] is not None else np.full(BLOCKS, inp["flat_price"])) * esc
        worth = np.minimum(price_b, 0.995 * lam) if inp["ppa_first"] else price_b
        cost[col["ex"]] -= worth * DT

    A = sp.csc_matrix((np.concatenate(rows_v), (np.concatenate(rows_i), np.concatenate(rows_j))), shape=(n_row, n_col))
    A.sum_duplicates()
    return {"A": A, "cost": cost, "lo": lo, "hi": hi, "rlo": np.concatenate(rlo), "rhi": np.concatenate(rhi), "col": col,
            "short0": short0, "floor_rows": floor_rows, "year": year, "dem": dem, "sgen": sgen, "wgen": wgen, "ren": ren,
            "eta": eta, "E": E, "bf": bf, "min_soc": min_soc, "BM": BM, "pl_live": pl_live, "peak_blocks": peak_blocks,
            "price_b": price_b, "inp": inp, "sizes": sizes}


def _result(m: dict, x: np.ndarray, status: str, seconds: float) -> dict:
    """Block series and checks of a solved year."""
    inp, sizes, col, year = m["inp"], m["sizes"], m["col"], m["year"]
    dem, sgen, wgen, ren, eta, E, bf, min_soc, BM = (m[k] for k in ("dem", "sgen", "wgen", "ren", "eta", "E", "bf", "min_soc", "BM"))
    pl_live, peak_blocks, price_b, short0, floor_rows, lo = m["pl_live"], m["peak_blocks"], m["price_b"], m["short0"], m["floor_rows"], m["lo"]
    out = {k: np.maximum(0.0, x[c]) for k, c in col.items()}
    ch, dis, direct = RLP.net_battery(out["ch"], out["dis"], out["dir"], eta)
    ex = out.get("ex", np.zeros(BLOCKS))
    biomass = out.get("bio", np.zeros(BLOCKS))
    pgen = {pl["id"]: out[f"pl:{pl['id']}"] for pl in pl_live}
    gen = ren + biomass + sum(pgen.values(), np.zeros(BLOCKS))
    curtail = np.maximum(0.0, gen - direct - ch - ex)
    delivered = direct + dis
    soc = (x[col["u"]] + min_soc * E * bf) / E if E > 1e-9 else np.zeros(BLOCKS)

    def share(mask: np.ndarray) -> float:
        need = dem[mask].sum()
        return float(delivered[mask].sum() / need) if need > 0 else 1.0

    rules_out = []
    for rule in inp["rules"]:
        groups = [(m, mask) for m, mask in _rule_groups(rule, peak_blocks) if mask.any()]
        achieved = min(share(mask) for _, mask in groups) if groups else 1.0
        short = sum(float(x[short0 + k]) for k, fr in enumerate(floor_rows) if fr["rule"] == rule["id"])
        rules_out.append({"id": rule["id"], "label": rule["label"], "target": rule["target"], "achieved": achieved,
                          "met": achieved >= rule["target"] - 1e-6, "shortfallMu": short / 1000})

    def plant_check(series: np.ndarray, mw: float) -> dict:
        step = np.abs(np.diff(series)) / mw if mw > 0 else np.zeros(1)
        return {"minPct": float(series.min() / mw) if mw > 0 else 0.0, "maxPct": float(series.max() / mw) if mw > 0 else 0.0,
                "maxStepPct": float(step.max(initial=0.0)), "mu": float(series.sum() * DT / 1000)}

    checks = {}
    if BM > 0:
        checks["biomass"] = {**plant_check(biomass, BM), "minLoad": lo[col["bio"][0]] / BM,
                             "rampPerBlock": float(inp["bio"]["rampPerHour"]) / BLOCKS_PER_HOUR if inp["bio"].get("rampPerHour") is not None else None}
    for pl in pl_live:
        mw = float(sizes[f"{pl['id']}Mw"])
        checks[pl["id"]] = {**plant_check(pgen[pl["id"]], mw), "minLoad": pl["min"],
                            "rampPerBlock": pl["ramp"] / BLOCKS_PER_HOUR if pl["ramp"] is not None else None}
    non_re = sum((pgen[pl["id"]] for pl in pl_live if not pl["green"]), np.zeros(BLOCKS))
    summary = {
        "year": year,
        "seconds": round(seconds, 1),
        "status": status,
        "demandMu": float(dem.sum() * DT / 1000),
        "deliveredMu": float(delivered.sum() * DT / 1000),
        "annualShare": float(delivered.sum() / dem.sum()) if dem.sum() > 0 else 1.0,
        "solarMu": float(sgen.sum() * DT / 1000),
        "windMu": float(wgen.sum() * DT / 1000),
        "soldMu": float(ex.sum() * DT / 1000),
        "curtailedMu": float(curtail.sum() * DT / 1000),
        "chargedMu": float(ch.sum() * DT / 1000),
        "dischargedMu": float(dis.sum() * DT / 1000),
        "greenShare": float(1 - non_re.sum() / delivered.sum()) if delivered.sum() > 0 else 1.0,
        "rules": rules_out,
        "shortfallMu": float(sum(r["shortfallMu"] for r in rules_out)),
        "allMet": all(r["met"] for r in rules_out),
        "plants": checks,
        "simultaneousBlocks": int(((ch > 1e-6) & (dis > 1e-6)).sum()),
    }
    series = {"demand": dem, "solar": sgen, "wind": wgen, "biomass": biomass, **pgen, "charge": ch, "discharge": dis,
              "soc": soc, "direct": direct, "delivered": delivered, "sold": ex, "curtailed": curtail}
    if price_b is not None:
        series["price"] = price_b
    return {"summary": summary, "series": series}


def _highs(m: dict, time_limit: float):
    h = highspy.Highs()
    h.setOptionValue("output_flag", False)
    h.setOptionValue("time_limit", float(time_limit))
    h.setOptionValue("solver", "ipm")
    h.setOptionValue("run_crossover", "on")
    lp = highspy.HighsLp()
    lp.num_col_, lp.num_row_ = m["A"].shape[1], m["A"].shape[0]
    lp.col_cost_, lp.col_lower_, lp.col_upper_ = m["cost"], m["lo"], m["hi"]
    lp.row_lower_, lp.row_upper_ = m["rlo"], m["rhi"]
    lp.a_matrix_.format_ = highspy.MatrixFormat.kColwise
    lp.a_matrix_.start_, lp.a_matrix_.index_, lp.a_matrix_.value_ = m["A"].indptr, m["A"].indices, m["A"].data
    h.passModel(lp)
    return h


def dispatch_years(inp: dict, sizes: dict, tariff: float, years: list[int], on_year: Callable[[dict], None] | None = None,
                   time_limit: float = 600.0) -> list[dict]:
    """Dispatch the plant in 15-minute blocks for each year. The first year is solved from scratch
    (interior point, then crossover to a basis); each later year changes only costs, bounds and
    right-hand sides, so dual simplex restarts from the previous year's basis."""
    if highspy is None:
        raise DispatchError("HiGHS (highspy) is not installed in the engine")
    out = []
    h = None
    for year in years:
        m = _build(inp, sizes, tariff, year)
        t0 = time.perf_counter()
        if h is None:
            h = _highs(m, time_limit)
        else:
            n_col, n_row = m["A"].shape[1], m["A"].shape[0]
            cols = np.arange(n_col, dtype=np.int32)
            h.changeColsCost(n_col, cols, m["cost"])
            h.changeColsBounds(n_col, cols, m["lo"], m["hi"])
            h.changeRowsBounds(n_row, np.arange(n_row, dtype=np.int32), m["rlo"], m["rhi"])
            h.setOptionValue("solver", "simplex")
        h.run()
        if h.getModelStatus() != highspy.HighsModelStatus.kOptimal and len(out):
            h = _highs(m, time_limit)  # the warm start failed: solve this year from scratch
            h.run()
        status = h.modelStatusToString(h.getModelStatus())
        if h.getModelStatus() != highspy.HighsModelStatus.kOptimal:
            raise DispatchError(f"Year {year}: HiGHS stopped with status '{status}'")
        res = _result(m, np.asarray(h.getSolution().col_value), status, time.perf_counter() - t0)
        out.append(res)
        if on_year:
            on_year(res)
    return out


def dispatch_year(inp: dict, sizes: dict, tariff: float, year: int, time_limit: float = 600.0) -> dict:
    """Dispatch the plant in 15-minute blocks for one PPA year. Returns the block series and checks."""
    return dispatch_years(inp, sizes, tariff, [year], time_limit=time_limit)[0]


# ----------------------------------------------------------------------------- files

def _day_block_labels() -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str]]:
    day = np.arange(BLOCKS) // 96 + 1
    block = np.arange(BLOCKS) % 96 + 1
    month_day = np.concatenate([np.arange(1, d + 1) for d in RLP.MONTH_DAYS])
    times = [f"{(k * 15) // 60:02d}:{(k * 15) % 60:02d}-{((k + 1) * 15) // 60 % 24:02d}:{((k + 1) * 15) % 60:02d}" for k in range(96)]
    return day, block, np.repeat(month_day, 96), times


def year_csv(series: dict, year: int) -> str:
    """One row per 15-minute block of the year (MW averages over the block)."""
    day, block, mday, times = _day_block_labels()
    cols = [("demand", "Contracted supply MW"), ("solar", "Solar output MW"), ("wind", "Wind output MW"),
            ("biomass", "Biomass output MW")]
    cols += [(k, f"{k.capitalize()} output MW") for k in series if k not in
             ("demand", "solar", "wind", "biomass", "charge", "discharge", "soc", "direct", "delivered", "sold", "curtailed", "price")]
    cols += [("charge", "Battery charging MW"), ("discharge", "Battery discharging MW"), ("soc", "Battery state of charge %"),
             ("direct", "Direct to PPA MW"), ("delivered", "Delivered to PPA MW"), ("sold", "Sold in market MW"),
             ("curtailed", "Curtailed MW")]
    if "price" in series:
        cols.append(("price", "Market price Rs/kWh"))
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["PPA year", "Day", "Month", "Date", "Block", "Time"] + [label for _, label in cols])
    data = [np.round(series[k] * (100 if k == "soc" else 1), 3 if k == "price" else 2) for k, _ in cols]
    month_idx = MONTH_OF_BLOCK
    for i in range(BLOCKS):
        w.writerow([year, int(day[i]), MONTHS[month_idx[i]], f"{int(mday[i]):02d}-{MONTHS[month_idx[i]]}", int(block[i]), times[block[i] - 1]]
                   + [f"{float(d[i]):.{3 if k == 'price' else 2}f}" for (k, _), d in zip(cols, data)])
    return buf.getvalue()


def summary_csv(summaries: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    rule_ids = [r["id"] for r in summaries[0]["rules"]] if summaries else []
    plant_ids = list(summaries[0]["plants"]) if summaries else []
    head = ["PPA year", "Delivered MU", "Contracted MU", "Annual supply %"]
    head += [f"{rid} floor achieved %" for rid in rule_ids] + [f"{rid} floor met" for rid in rule_ids]
    head += ["Shortfall MU", "Solar MU", "Wind MU", "Sold MU", "Curtailed MU", "Battery charged MU", "Battery discharged MU", "Green share %"]
    for pid in plant_ids:
        head += [f"{pid} MU", f"{pid} lowest output % of MW", f"{pid} technical minimum %", f"{pid} largest 15-min change % of MW", f"{pid} ramp limit per block %"]
    w.writerow(head)
    for s in summaries:
        row = [s["year"], round(s["deliveredMu"], 2), round(s["demandMu"], 2), round(100 * s["annualShare"], 2)]
        row += [round(100 * r["achieved"], 2) for r in s["rules"]] + ["yes" if r["met"] else "NO" for r in s["rules"]]
        row += [round(s["shortfallMu"], 3), round(s["solarMu"], 2), round(s["windMu"], 2), round(s["soldMu"], 2), round(s["curtailedMu"], 2),
                round(s["chargedMu"], 2), round(s["dischargedMu"], 2), round(100 * s["greenShare"], 2)]
        for pid in plant_ids:
            c = s["plants"][pid]
            row += [round(c["mu"], 2), round(100 * c["minPct"], 2), round(100 * c["minLoad"], 2), round(100 * c["maxStepPct"], 2),
                    round(100 * c["rampPerBlock"], 2) if c["rampPerBlock"] is not None else ""]
        w.writerow(row)
    return buf.getvalue()


README = """15-minute dispatch, every PPA year (Tender to Bid)

dispatch_15min_year_NN.csv  one row per 15-minute block (96 a day, 35,040 a year); MW are block averages
summary_by_year.csv         energy, each supply floor (achieved and met), shortfall, and each plant's
                            lowest output and largest 15-minute change against its technical minimum
                            and ramp limit
request.json                the plant sizes, tariff and inputs used

How it is computed
* The plant sizes are those of the sizing (HiGHS, hourly). Each PPA year is dispatched by its own
  HiGHS LP in 15-minute blocks, with that year's solar and wind degradation and battery capacity.
* Biomass and other dispatchable plants stay at or above their technical minimum in every block and
  change by no more than their ramp rate per block (ramp %/min x 15 minutes).
* The battery charges from renewable output only, within its power and energy, and does not charge
  and discharge in the same block.
* The tender's supply floors are applied as in the sizing (peak hours: every hour of the day, each
  month, when the procurer picks the hours). A floor that cannot be met is reported with its shortfall.
* Solar and wind profiles are hourly: each hour is split into four 15-minute values along the hour's
  trend, keeping the hour's energy. Demand and market prices take the hour's value in each block.
* Days are numbered from 1 January of the profile year; PPA year N uses year N's degradation.
"""


# ----------------------------------------------------------------------------- jobs

MAX_AGE_SECONDS = 24 * 3600
_JOB_ID = re.compile(r"^[0-9a-f]{32}$")
_lock = threading.Lock()
_slots = threading.Semaphore(1)  # one 15-minute dispatch at a time per engine process


def jobs_dir() -> Path:
    path = Path(os.environ.get("DISPATCH15_JOBS_DIR") or os.path.join(tempfile.gettempdir(), "fdre_dispatch15"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def _write(job: dict) -> None:
    job["updated_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    handle, tmp = tempfile.mkstemp(prefix=".job-", suffix=".tmp", dir=jobs_dir())
    with os.fdopen(handle, "w", encoding="utf-8") as out:
        json.dump(job, out, default=float)
    os.replace(tmp, jobs_dir() / f"{job['job_id']}.json")


def _cleanup() -> None:
    cutoff = time.time() - MAX_AGE_SECONDS
    for path in jobs_dir().glob("*"):
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            continue


def run(payload: dict, sizes: dict, tariff: float, years: list[int] | None = None,
        progress: Callable[[int, int, dict | None], None] | None = None, zip_path: Path | None = None) -> dict:
    """Dispatch every requested year; write the ZIP (when zip_path is given); return the summaries."""
    inp = _inputs(payload)
    n = int(inp["fin"].get("years") or 25)
    years = years or list(range(1, n + 1))
    if not all(isinstance(y, int) and 1 <= y <= n for y in years):
        raise DispatchError(f"years must be within 1..{n}")
    if not (isinstance(tariff, (int, float)) and math.isfinite(tariff) and tariff > 0):
        raise DispatchError("tariff must be a positive number (Rs/kWh)")
    summaries = []
    zf = zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) if zip_path else None
    try:
        if progress:
            progress(0, len(years), None)

        def on_year(res: dict) -> None:
            summaries.append(res["summary"])
            if zf:
                zf.writestr(f"dispatch_15min_year_{res['summary']['year']:02d}.csv", year_csv(res["series"], res["summary"]["year"]))
            if progress:
                progress(len(summaries), len(years), res["summary"])

        dispatch_years(inp, sizes, float(tariff), years, on_year)
        if zf:
            zf.writestr("summary_by_year.csv", summary_csv(summaries))
            zf.writestr("README.txt", README)
            zf.writestr("request.json", json.dumps({"sizes": sizes, "tariff": tariff, "years": years,
                                                    "payload": {k: v for k, v in payload.items() if k not in ("ctx", "peakMask")}}, indent=2, default=float))
    finally:
        if zf:
            zf.close()
    return {"years": summaries, "allMet": all(s["allMet"] for s in summaries)}


def start(payload: dict, sizes: dict, tariff: float, years: list[int] | None = None) -> str:
    """Queue a 25-year 15-minute dispatch in a daemon thread. Returns the job id."""
    _inputs(payload)  # fail fast on a malformed request
    if not (isinstance(tariff, (int, float)) and math.isfinite(tariff) and tariff > 0):
        raise DispatchError("tariff must be a positive number (Rs/kWh)")
    for key, value in sizes.items():
        if not (isinstance(value, (int, float)) and math.isfinite(value) and value >= 0):
            raise DispatchError(f"size {key} must be a number of MW or MWh")
    _cleanup()
    job_id = uuid.uuid4().hex
    job: dict[str, Any] = {"job_id": job_id, "status": "queued", "progress": {"done": 0, "total": len(years or []) or int((payload.get("fin") or {}).get("years") or 25)},
                           "years": [], "error": None, "created_at": datetime.now(UTC).isoformat(timespec="seconds")}
    _write(job)

    def progress(done: int, total: int, summary: dict | None) -> None:
        with _lock:
            job["status"] = "running"
            job["progress"] = {"done": done, "total": total}
            if summary is not None:
                job["years"].append(summary)
            _write(job)

    def work() -> None:
        path = jobs_dir() / f"{job_id}.zip"
        try:
            with _slots:
                out = run(payload, sizes, tariff, years, progress, zip_path=path)
            with _lock:
                job["status"] = "done"
                job["allMet"] = out["allMet"]
                _write(job)
        except Exception as exc:  # noqa: BLE001 - reported to the poller
            with _lock:
                job["status"] = "failed"
                job["error"] = str(exc)[:1000]
                _write(job)

    threading.Thread(target=work, name=f"dispatch15-{job_id[:8]}", daemon=True).start()
    return job_id


def get(job_id: str) -> dict | None:
    if not isinstance(job_id, str) or not _JOB_ID.match(job_id):
        return None
    path = jobs_dir() / f"{job_id}.json"
    for _ in range(3):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (json.JSONDecodeError, OSError):
            time.sleep(0.05)
    return None


def zip_file(job_id: str) -> Path | None:
    if not isinstance(job_id, str) or not _JOB_ID.match(job_id):
        return None
    path = jobs_dir() / f"{job_id}.zip"
    return path if path.is_file() else None
