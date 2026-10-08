"""Build the hourly IEX price year used by Tender to Bid from 15-minute market-clearing prices.

Usage (from the repository root):
    python tools/build_iex_prices.py --dam DAM.xlsx --gdam GDAM.xlsx --rtm RTM.xlsx \
        --out web/public/market/iex_hourly_prices.json

Each workbook has one row per 15-minute block with columns Date, Time Block and
"MCP (₹/MWh)" (the IEX market-clearing price). For every hour of a 365-day year (1 January to
31 December, no 29 February) the price is the mean of that hour's four blocks on the most recent
date with data for the same month and day, so a 12+ month extract gives one full calendar year.
A day missing from the extract takes the same weekday a week either side (else the nearest
day); blocks missing on a day are filled from the same block on the nearest day.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from collections import defaultdict
from pathlib import Path

import openpyxl

MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
LABELS = {
    "GDAM": "Green Day-Ahead Market",
    "DAM": "Day-Ahead Market",
    "RTM": "Real-Time Market",
}


def _block_index(text: str) -> int:
    """'00:15 - 00:30' or '00:15-00:30' -> 1 (0..95)."""
    start = str(text).split("-")[0].strip()
    hh, mm = start.split(":")
    return int(hh) * 4 + int(mm) // 15


def read_blocks(path: Path) -> tuple[dict[dt.date, dict[int, float]], dict[dt.date, dict[int, float]]]:
    """({date: {block: MCP Rs/MWh}}, {date: {block: cleared volume MW}}); duplicate rows for a
    block are averaged. The cleared volume is "Total MCV" (GDAM) or "MCV" (DAM, RTM): the
    average MW cleared in the block (IEX labels the GDAM column MWh; its magnitude, about
    0.9 GW at night, is the market's MW, matching its monthly volumes of 600-900 MU)."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    head = [str(h).strip() if h is not None else "" for h in next(rows)]
    i_date = head.index("Date")
    i_block = head.index("Time Block")
    i_mcp = next(i for i, h in enumerate(head) if h.startswith("MCP"))
    i_mcv = next((i for i, h in enumerate(head) if h.startswith("Total MCV")), None)
    if i_mcv is None:
        i_mcv = next(i for i, h in enumerate(head) if h.startswith("MCV"))
    sums: dict[tuple[dt.date, int], list[float]] = defaultdict(list)
    vols: dict[tuple[dt.date, int], list[float]] = defaultdict(list)
    for r in rows:
        if r[i_date] is None or r[i_mcp] is None:
            continue
        d = r[i_date] if isinstance(r[i_date], dt.date) else dt.date.fromisoformat(str(r[i_date])[:10])
        if isinstance(d, dt.datetime):
            d = d.date()
        key = (d, _block_index(r[i_block]))
        sums[key].append(float(r[i_mcp]))
        if r[i_mcv] is not None:
            vols[key].append(float(r[i_mcv]))
    out: dict[dt.date, dict[int, float]] = defaultdict(dict)
    vol: dict[dt.date, dict[int, float]] = defaultdict(dict)
    for (d, b), vals in sums.items():
        out[d][b] = sum(vals) / len(vals)
        if vols.get((d, b)):
            vol[d][b] = sum(vols[(d, b)]) / len(vols[(d, b)])
    wb.close()
    return out, vol


def hourly_year(blocks: dict[dt.date, dict[int, float]]) -> tuple[list[int], dict]:
    """8,760 hourly prices (Rs/MWh) for a calendar year, and how they were assembled."""
    dates = sorted(blocks)
    by_md: dict[tuple[int, int], list[dt.date]] = defaultdict(list)
    for d in dates:
        by_md[(d.month, d.day)].append(d)
    prices: list[int] = []
    filled = 0
    used_years: dict[int, int] = defaultdict(int)
    days_filled: list[str] = []
    last = dates[-1]
    for m, days in enumerate(MONTH_DAYS, start=1):
        for day in range(1, days + 1):
            candidates = by_md.get((m, day))
            if candidates:
                d = max(candidates)  # the most recent year with this day
            else:
                # a day missing from the extract: the same weekday a week either side, else the
                # nearest day with data
                want = dt.date(last.year if (m, day) <= (last.month, last.day) else last.year - 1, m, day)
                near = [want + dt.timedelta(days=k) for k in (-7, 7, -14, 14)]
                d = next((x for x in near if x in blocks), None) or min(dates, key=lambda x: abs((x - want).days))
                days_filled.append(f"{want.isoformat()} from {d.isoformat()}")
            used_years[d.year] += 1
            day_blocks = blocks[d]
            for h in range(24):
                vals = []
                for b in range(h * 4, h * 4 + 4):
                    v = day_blocks.get(b)
                    if v is None:  # nearest day that has this block
                        filled += 1
                        near = sorted(dates, key=lambda x: abs((x - d).days))
                        v = next(blocks[x][b] for x in near if b in blocks[x])
                    vals.append(v)
                prices.append(round(sum(vals) / 4))
    assert len(prices) == 8760
    return prices, {"daysFromYear": dict(sorted(used_years.items())), "blocksFilled": filled, "daysFilled": days_filled}


def summary(prices: list[int]) -> dict:
    monthly, k = [], 0
    for days in MONTH_DAYS:
        n = days * 24
        monthly.append(round(sum(prices[k:k + n]) / n))
        k += n
    by_hour = [round(sum(prices[h::24]) / 365) for h in range(24)]
    return {"meanRsPerMwh": round(sum(prices) / len(prices)), "minRsPerMwh": min(prices), "maxRsPerMwh": max(prices),
            "monthlyMeanRsPerMwh": monthly, "hourOfDayMeanRsPerMwh": by_hour}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dam", type=Path)
    ap.add_argument("--gdam", type=Path)
    ap.add_argument("--rtm", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    markets = {}
    for key, path in (("GDAM", args.gdam), ("DAM", args.dam), ("RTM", args.rtm)):
        if path is None:
            continue
        blocks, volumes = read_blocks(path)
        dates = sorted(blocks)
        prices, how = hourly_year(blocks)
        mcv, _ = hourly_year(volumes)
        markets[key] = {
            "label": LABELS[key],
            "source": f"IEX {key} 15-minute market-clearing price (MCP), {dates[0]} to {dates[-1]}",
            "from": dates[0].isoformat(),
            "to": dates[-1].isoformat(),
            "days": len(dates),
            **how,
            **summary(prices),
            "meanMcvMw": round(sum(mcv) / len(mcv)),
            "hourlyRsPerMwh": prices,
            "hourlyMcvMw": mcv,
        }
        print(f"{key}: {dates[0]}..{dates[-1]} ({len(dates)} days), mean Rs {markets[key]['meanRsPerMwh']}/MWh, "
              f"{how['blocksFilled']} blocks filled, days by year {how['daysFromYear']}, days filled {how['daysFilled']}")
    payload = {
        "unit": "Rs/MWh",
        "year": "calendar year of 8,760 hours (1 Jan 00:00 to 31 Dec 23:00); each day from the latest year with data",
        "markets": markets,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"wrote {args.out} ({args.out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
