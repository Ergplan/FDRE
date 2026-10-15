"""Profile ingestion and validation: timestamps, timezone, interval duration, leap years,
missing and duplicate intervals, normalisation to the model's hourly year, physical bounds
and the content hash that identifies the series in every run snapshot."""

from __future__ import annotations

import csv
import hashlib
import io
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

HOURS = 8760


@dataclass
class ProfileReport:
    ok: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    resolution_minutes: int | None = None
    timezone: str | None = None
    year: int | None = None
    intervals: int = 0
    missing_intervals: int = 0
    duplicate_intervals: int = 0
    leap_day_handling: str | None = None
    basis: str = "capacity_factor"
    stats: dict[str, float] = field(default_factory=dict)
    sha256: str | None = None
    hourly: list[float] | None = None   # normalised to 8760 values in the profile's basis


def parse_csv(text: str) -> tuple[list[datetime | None], list[float], list[str]]:
    """Columns: either (timestamp, value) or a single value column. Returns timestamps
    (None when absent), values and notes."""
    rows = list(csv.reader(io.StringIO(text)))
    notes: list[str] = []
    if not rows:
        return [], [], ["empty file"]
    header = [h.strip().lower() for h in rows[0]]
    has_header = any(h in ("timestamp", "time", "datetime", "date", "value", "mw", "cf", "capacity_factor", "mwh", "price") for h in header)
    body = rows[1:] if has_header else rows
    ts_col = None
    val_col = None
    if has_header:
        for i, h in enumerate(header):
            if h in ("timestamp", "time", "datetime", "date") and ts_col is None:
                ts_col = i
            if h in ("value", "mw", "cf", "capacity_factor", "mwh", "price", "inr_per_kwh") and val_col is None:
                val_col = i
    if val_col is None:
        val_col = 1 if (body and len(body[0]) > 1) else 0
        if ts_col is None and body and len(body[0]) > 1:
            ts_col = 0
    timestamps: list[datetime | None] = []
    values: list[float] = []
    for n, row in enumerate(body, start=2 if has_header else 1):
        if not row or all(not c.strip() for c in row):
            continue
        try:
            values.append(float(row[val_col]))
        except (ValueError, IndexError):
            notes.append(f"line {n}: value is not a number")
            continue
        if ts_col is not None:
            raw = row[ts_col].strip()
            ts = _parse_ts(raw)
            if ts is None:
                notes.append(f"line {n}: timestamp {raw!r} not understood")
            timestamps.append(ts)
        else:
            timestamps.append(None)
    return timestamps, values, notes


def _parse_ts(raw: str) -> datetime | None:
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S%z", "%Y-%m-%dT%H:%M%z", "%Y-%m-%d %H:%M%z", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M", "%d-%m-%Y %H:%M", "%d/%m/%Y %H:%M"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def validate(
    text: str, *, basis: str = "capacity_factor", timezone: str | None = None, interval_minutes: int | None = None, start: str | None = None,
    leap_day: str = "drop", capacity_mw: float | None = None, allow_clip: bool = True,
) -> ProfileReport:
    """Validate and normalise a profile. `timezone` is required (declared or in the
    timestamps). Values are capacity factors (0-1), MW or MWh per interval; MW and MWh
    need `capacity_mw` to be turned into capacity factors."""
    report = ProfileReport(ok=False, basis=basis)
    timestamps, values, notes = parse_csv(text)
    report.warnings.extend(notes)
    if not values:
        report.errors.append("no numeric values found")
        return report
    report.intervals = len(values)
    # Timezone
    tz_from_data = next((t.tzinfo for t in timestamps if t is not None and t.tzinfo is not None), None)
    tzname = timezone or (str(tz_from_data) if tz_from_data else None)
    if not tzname:
        report.errors.append("timezone is required: declare it or use timezone-aware timestamps")
    else:
        try:
            ZoneInfo(tzname) if tzname not in ("UTC", "Z") else None
        except ZoneInfoNotFoundError:
            if not tz_from_data:
                report.errors.append(f"unknown timezone {tzname!r}")
    report.timezone = tzname
    # Timestamps and interval
    stamped = [t for t in timestamps if t is not None]
    if stamped and len(stamped) == len(values):
        deltas = sorted({int((b - a).total_seconds() // 60) for a, b in zip(stamped, stamped[1:], strict=False)})
        positive = [d for d in deltas if d > 0]
        inferred = positive[0] if positive else None
        if interval_minutes and inferred and inferred != interval_minutes:
            report.errors.append(f"declared interval {interval_minutes} min but the timestamps step by {inferred} min")
        res = interval_minutes or inferred
        if res not in (15, 30, 60):
            report.errors.append(f"interval {res} min is not supported (15, 30 or 60)")
        report.resolution_minutes = res
        seen: set[datetime] = set()
        dups = 0
        for t in stamped:
            if t in seen:
                dups += 1
            seen.add(t)
        report.duplicate_intervals = dups
        if dups:
            report.errors.append(f"{dups} duplicate interval(s)")
        if res:
            expected = int((stamped[-1] - stamped[0]).total_seconds() // 60 // res) + 1
            missing = expected - len(seen)
            report.missing_intervals = max(0, missing)
            if missing > 0:
                report.errors.append(f"{missing} missing interval(s) between {stamped[0].isoformat()} and {stamped[-1].isoformat()}")
            if any(d < 0 for d in deltas):
                report.errors.append("timestamps are not in increasing order")
        report.year = stamped[0].year
        first_year = stamped[0].year
        leap = _is_leap(first_year)
        if leap and res:
            per_day = 24 * 60 // res
            if len(values) >= 366 * per_day:
                if leap_day == "drop":
                    keep = [i for i, t in enumerate(stamped) if not (t.month == 2 and t.day == 29)]
                    values = [values[i] for i in keep]
                    stamped = [stamped[i] for i in keep]
                    report.leap_day_handling = "29 February dropped (366-day year normalised to 365)"
                elif leap_day == "reject":
                    report.errors.append("leap year series (366 days) rejected by policy")
                else:
                    report.errors.append(f"unknown leap-day policy {leap_day!r}")
    else:
        if stamped:
            report.errors.append(f"{len(values) - len(stamped)} row(s) without a timestamp")
        res = interval_minutes or 60
        report.resolution_minutes = res
        if start:
            s = _parse_ts(start)
            report.year = s.year if s else None
        per_year = 365 * 24 * 60 // res
        if len(values) == per_year + 24 * 60 // res:
            if leap_day == "drop":
                # Without timestamps, assume 29 February is the 60th day.
                per_day = 24 * 60 // res
                values = values[: 59 * per_day] + values[60 * per_day :]
                report.leap_day_handling = "366-day series: day 60 dropped as 29 February"
            else:
                report.errors.append("366-day series rejected by policy")
        elif len(values) != per_year:
            report.errors.append(f"{len(values)} values for {res}-min intervals; a non-leap year needs {per_year}")
    # Basis and bounds
    cf = list(values)
    if basis in ("mw", "mwh_per_interval"):
        if not capacity_mw or capacity_mw <= 0:
            report.errors.append(f"a profile in {basis} needs the capacity it refers to (capacity_mw)")
        else:
            hours = (report.resolution_minutes or 60) / 60.0
            cf = [v / capacity_mw if basis == "mw" else v / (capacity_mw * hours) for v in values]
    elif basis != "capacity_factor":
        report.errors.append(f"unknown basis {basis!r}")
    negatives = sum(1 for v in cf if v < 0)
    if negatives:
        report.errors.append(f"{negatives} negative value(s)")
    above = sum(1 for v in cf if v > 1.0 + 1e-9)
    if above:
        worst = max(cf)
        if allow_clip and worst <= 1.05:
            report.warnings.append(f"{above} value(s) above 1.0 (max {worst:.3f}) clipped to 1.0")
            cf = [min(v, 1.0) for v in cf]
        else:
            report.errors.append(f"{above} value(s) above the capacity (max {worst:.3f}); the capacity basis is wrong or the series is not a capacity factor")
    if report.errors:
        return report
    # Normalise to hourly
    res = report.resolution_minutes or 60
    per_hour = 60 // res
    hourly = [sum(cf[i : i + per_hour]) / per_hour for i in range(0, len(cf), per_hour)] if per_hour > 1 else cf
    if len(hourly) != HOURS:
        report.errors.append(f"normalised series has {len(hourly)} hours, expected {HOURS}")
        return report
    report.hourly = [round(v, 6) for v in hourly]
    report.sha256 = hashlib.sha256((",".join(f"{v:.6f}" for v in report.hourly) + f"|{basis}|{tzname}").encode()).hexdigest()
    mean = sum(hourly) / HOURS
    report.stats = {"cuf": round(mean, 5), "max": round(max(hourly), 5), "min": round(min(hourly), 5), "zero_hours": sum(1 for v in hourly if v <= 1e-9), "energy_mwh_per_mw": round(mean * HOURS, 2)}
    report.ok = True
    return report


def scale_to_cuf(hourly: list[float], target_cuf: float) -> tuple[list[float], float]:
    """Scale a capacity-factor series to a target annual CUF without exceeding 1.0. Returns
    the series and the energy fraction lost to clipping at 1.0 (0 when none)."""
    if target_cuf <= 0:
        return [0.0] * len(hourly), 0.0
    out = list(hourly)
    lost = 0.0
    for _ in range(8):
        mean = sum(out) / len(out)
        if mean <= 1e-12:
            break
        factor = target_cuf / mean
        scaled = [v * factor for v in out]
        clipped = [min(v, 1.0) for v in scaled]
        lost = (sum(scaled) - sum(clipped)) / max(sum(scaled), 1e-12)
        out = clipped
        if abs(sum(out) / len(out) - target_cuf) < 1e-6:
            break
    return out, lost


def _is_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def synthetic_hourly(technology: str, cuf: float, seed: int = 42) -> list[float]:
    """The engine's synthetic series (same generator, so a synthetic module reconciles with
    the engine run exactly)."""
    import fdre_enterprise_engine as E

    return [float(v) for v in E.synthetic_capacity_factor(technology, cuf, seed=seed)]


def describe(report: ProfileReport) -> dict[str, Any]:
    d = report.__dict__.copy()
    d.pop("hourly", None)
    return d


def hourly_from_values(values: list[float]) -> list[float]:
    return [float(v) for v in values]
