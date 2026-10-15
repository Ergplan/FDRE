"""Historical tender results: import from Ergplan/RE-tender-results with a stable key, the
units and statuses exactly as published, the source and page, and the dataset's freshness;
comparable-tender search that explains each match and never compares incompatible units
or tender structures as equivalent tariffs."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
from datetime import date, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from fdre_platform.models import HistoricalAward, HistoricalSource

ADMISSIBLE_HOSTS = ("seci.co.in", "cercind.gov.in", "sjvn.nic.in", "ireda.in", "ntpc.co.in", "nhpc.nic.in", "nlcindia.in")

FAMILY_MAP = [
    (r"FDRE|RTC|peak|assured|firm", "fdre"),
    (r"wind.?solar hybrid|hybrid", "hybrid"),
    (r"solar.*storage|solar \+ storage", "solar_storage"),
    (r"battery storage|BESS", "bess"),
    (r"pumped", "pumped_storage"),
    (r"rooftop", "rooftop_solar"),
    (r"^solar$", "solar"),
    (r"^wind$", "wind"),
    (r"hydrogen|ammonia|electrolyser|manufacturing", "non_power"),
    (r"services|empanelment", "services"),
]


def family_of(technology: str) -> str:
    for pattern, fam in FAMILY_MAP:
        if re.search(pattern, technology, re.I):
            return fam
    return "other"


def result_kind_of(rec: dict[str, Any]) -> str:
    status = (rec.get("status") or "").lower()
    unit = (rec.get("priceUnit") or "").lower()
    if "vgf" in unit:
        return "vgf_support"
    if unit and "inr/kwh" not in unit:
        return "non_tariff"
    if "cancel" in status or "terminat" in status:
        return "cancelled"
    if "empanel" in status:
        return "empanelment"
    if "l1" in status or "rank" in status:
        return "ranking"
    if "adopt" in status:
        return "adopted_tariff"
    if "award" in status or "selected" in status or "allocation" in status:
        return "awarded_tariff" if rec.get("price") is not None else "other"
    return "other"


def _date(raw: str | None) -> date | None:
    if not raw:
        return None
    m = re.match(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", raw.strip())
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            return None
    try:
        return datetime.strptime(raw.strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def stable_key(source_sha: str, page: Any, bidder: str, allocation: str, reference: str) -> str:
    return hashlib.sha256(f"{source_sha}|{page}|{bidder.strip().lower()}|{allocation.strip().lower()}|{reference}".encode()).hexdigest()


def import_dataset(session: Session, root: pathlib.Path, *, commit_ref: str = "unknown") -> dict[str, Any]:
    """Idempotent import of tender-results-viewer/public/data.json (and the SECI RfS numbers
    from seci-data/records.json when present). Returns counts."""
    data = json.loads((root / "tender-results-viewer" / "public" / "data.json").read_text())
    dataset = f"RE-tender-results@{commit_ref}"
    as_of = _as_of(data.get("asOf"))
    sources = {s["id"]: s for s in data["sources"]}
    seci_refs: dict[str, str] = {}
    seci_path = root / "seci-data" / "records.json"
    if seci_path.exists():
        for r in json.loads(seci_path.read_text()):
            if r.get("tender_id") and r.get("tender_reference"):
                seci_refs[str(r["tender_id"])] = r["tender_reference"]
    rejected_hosts: dict[str, int] = {}
    inserted_sources = 0
    for s in data["sources"]:
        host = s["url"].split("/")[2].lower()
        if not any(host == h or host.endswith("." + h) for h in ADMISSIBLE_HOSTS):
            rejected_hosts[host] = rejected_hosts.get(host, 0) + 1
            continue
        if session.scalar(select(HistoricalSource).where(HistoricalSource.sha256 == s["sha256"])) is None:
            session.add(HistoricalSource(dataset=dataset, source_id=s["id"], name=s["name"], url=s["url"], host=host, kind=s["kind"], sha256=s["sha256"], checked_on=_date(s.get("checked")), created_by=None))
            inserted_sources += 1
    session.flush()
    inserted = 0
    skipped = 0
    for rec in data["records"]:
        src = sources.get(rec["source"])
        if src is None:
            skipped += 1
            continue
        host = src["url"].split("/")[2].lower()
        if not any(host == h or host.endswith("." + h) for h in ADMISSIBLE_HOSTS):
            skipped += 1
            continue
        reference = rec.get("reference") or ""
        rfs = seci_refs.get(reference, reference)
        key = stable_key(src["sha256"], rec.get("page"), rec["bidder"], rec["allocation"], reference)
        if session.scalar(select(HistoricalAward.id).where(HistoricalAward.stable_key == key)):
            skipped += 1
            continue
        unit = rec.get("priceUnit") or None
        tech = rec.get("technology") or ""
        session.add(
            HistoricalAward(
                stable_key=key, dataset=dataset, dataset_as_of=as_of, procurer=rec["agency"], tender_title=rec["project"], tender_reference=rfs, tender_family=family_of(tech), technology_as_stated=tech,
                bidder=rec["bidder"], allocation=rec["allocation"], capacity=rec.get("capacity"), capacity_unit=rec.get("capacityUnit") or None, price=rec.get("price"), price_unit=unit, currency="INR" if unit and "inr" in unit.lower() else None,
                adopted_capacity=rec.get("adopted"), adopted_price=rec.get("adoptedPrice"), result_kind=result_kind_of(rec), status_as_stated=rec.get("status") or "", award_date=_date(rec.get("date")), date_as_stated=rec.get("date"), date_type=rec.get("dateType"),
                contract_duration_years=_ppa_years(rec), storage_or_delivery_conditions=_conditions(tech, rec.get("notes")), notes=rec.get("notes") or None, verification=rec.get("verification"), flagged=bool(rec.get("flag")),
                source_id=rec["source"], source_url=src["url"], source_sha256=src["sha256"], source_page=str(rec.get("page")) if rec.get("page") is not None else None, source_checked_on=_date(src.get("checked")), related_url=rec.get("related"), raw=rec, created_by=None,
            )
        )
        inserted += 1
    session.flush()
    return {"dataset": dataset, "as_of": as_of.isoformat() if as_of else None, "records_inserted": inserted, "records_skipped": skipped, "sources_inserted": inserted_sources, "rejected_hosts": rejected_hosts, "total_records_in_dataset": len(data["records"])}


def _as_of(raw: str | None) -> date | None:
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%d %B %Y").date()
    except ValueError:
        return _date(raw)


def _ppa_years(rec: dict[str, Any]) -> int | None:
    unit = (rec.get("priceUnit") or "").lower()
    if "months (ppa term)" in unit and rec.get("price"):
        return int(round(float(rec["price"]) / 12))
    m = re.search(r"(\d{2})\s*[- ]?year", (rec.get("project") or "") + " " + (rec.get("notes") or ""), re.I)
    return int(m.group(1)) if m else None


def _conditions(tech: str, notes: str | None) -> str | None:
    bits = []
    if re.search(r"storage|BESS|FDRE|RTC|peak|assured", tech, re.I):
        bits.append(tech)
    if notes and re.search(r"storage|peak|RTC|availability|CUF", notes, re.I):
        bits.append(notes)
    return "; ".join(bits) or None


def freshness(session: Session) -> dict[str, Any]:
    row = session.execute(select(func.count(HistoricalAward.id), func.max(HistoricalAward.dataset_as_of), func.max(HistoricalAward.source_checked_on), func.max(HistoricalAward.award_date))).one()
    total, as_of, checked, latest = row
    missing = session.execute(select(func.count(HistoricalAward.id)).where(HistoricalAward.price.is_(None))).scalar_one()
    missing_date = session.execute(select(func.count(HistoricalAward.id)).where(HistoricalAward.award_date.is_(None))).scalar_one()
    return {"records": total, "dataset_as_of": as_of.isoformat() if as_of else None, "sources_last_checked": checked.isoformat() if checked else None, "latest_award_date": latest.isoformat() if latest else None, "records_without_price": missing, "records_without_date": missing_date, "note": "a research snapshot, not an exhaustive or live register; new results arrive through the importer, never automatically"}


def comparables(session: Session, *, tender_family: str | None = None, procurer: str | None = None, capacity_mw: float | None = None, storage: bool | None = None, contract_years: int | None = None, since: date | None = None, limit: int = 50, tariff_only: bool = True) -> list[dict[str, Any]]:
    """Comparable awards with an explanation per match. Only INR/kWh results compare as tariffs;
    other units are returned with `comparable_tariff: false` and the reason."""
    stmt = select(HistoricalAward)
    if tender_family:
        fams = {"fdre": ("fdre",), "re_rtc": ("fdre",), "hybrid": ("hybrid", "fdre"), "solar": ("solar", "solar_storage"), "wind": ("wind",), "bess": ("bess", "solar_storage")}.get(tender_family, (tender_family,))
        stmt = stmt.where(HistoricalAward.tender_family.in_(fams))
    if procurer:
        stmt = stmt.where(HistoricalAward.procurer.ilike(f"%{procurer}%"))
    if since:
        stmt = stmt.where(HistoricalAward.award_date >= since)
    rows = list(session.scalars(stmt.order_by(HistoricalAward.award_date.desc().nullslast()).limit(500)))
    out = []
    for r in rows:
        reasons = []
        score = 0.0
        if tender_family and r.tender_family in {"fdre": ("fdre",), "re_rtc": ("fdre",), "hybrid": ("hybrid", "fdre")}.get(tender_family, (tender_family,)):
            reasons.append(f"same family ({r.tender_family}: {r.technology_as_stated})")
            score += 3
        if procurer and procurer.lower() in r.procurer.lower():
            reasons.append(f"same procurer ({r.procurer})")
            score += 1
        if capacity_mw and r.capacity and r.capacity_unit == "MW":
            ratio = min(r.capacity, capacity_mw) / max(r.capacity, capacity_mw)
            if ratio >= 0.5:
                reasons.append(f"capacity within 2x ({r.capacity:g} MW)")
                score += ratio
        if storage is not None:
            has_storage = bool(re.search(r"storage|BESS|FDRE|RTC|peak|assured", r.technology_as_stated, re.I))
            if has_storage == storage:
                reasons.append("storage/firmness condition matches" if storage else "no storage condition, as asked")
                score += 1
            else:
                reasons.append("storage condition differs")
                score -= 1
        if contract_years and r.contract_duration_years:
            if r.contract_duration_years == contract_years:
                reasons.append(f"same contract duration ({contract_years} years)")
                score += 0.5
            else:
                reasons.append(f"contract duration differs ({r.contract_duration_years} years)")
        comparable = r.price_unit is not None and r.price_unit.lower() == "inr/kwh" and r.result_kind in ("awarded_tariff", "adopted_tariff", "discovered_tariff")
        why_not = None
        if not comparable:
            why_not = "no price" if r.price is None else (f"unit {r.price_unit} is not a tariff" if (r.price_unit or "").lower() != "inr/kwh" else f"result is {r.result_kind}, not an awarded or adopted tariff")
        if tariff_only and not comparable:
            continue
        out.append(
            {
                "id": r.id, "procurer": r.procurer, "tender_title": r.tender_title, "tender_reference": r.tender_reference, "tender_family": r.tender_family, "technology_as_stated": r.technology_as_stated, "bidder": r.bidder, "allocation": r.allocation,
                "capacity": r.capacity, "capacity_unit": r.capacity_unit, "price": r.price, "price_unit": r.price_unit, "currency": r.currency, "adopted_capacity": r.adopted_capacity, "adopted_price": r.adopted_price, "result_kind": r.result_kind,
                "status_as_stated": r.status_as_stated, "award_date": r.award_date.isoformat() if r.award_date else None, "date_type": r.date_type, "contract_duration_years": r.contract_duration_years, "storage_or_delivery_conditions": r.storage_or_delivery_conditions,
                "flagged": r.flagged, "notes": r.notes, "verification": r.verification, "source_url": r.source_url, "source_page": r.source_page, "source_sha256": r.source_sha256, "source_checked_on": r.source_checked_on.isoformat() if r.source_checked_on else None,
                "dataset": r.dataset, "similarity": round(score, 2), "why_similar": reasons, "comparable_tariff": comparable, "why_not_comparable": why_not,
                "missing": [k for k, v in (("price", r.price), ("capacity", r.capacity), ("award_date", r.award_date), ("contract_duration", r.contract_duration_years)) if v is None],
            }
        )
    out.sort(key=lambda x: (-x["similarity"], x["award_date"] or ""))
    return out[:limit]


def dedupe_candidates(session: Session, records: list[dict[str, Any]]) -> dict[str, Any]:
    """Interface for future ingestion: report which of the given candidate rows already
    exist (by stable key) and which are new, without writing anything."""
    new, existing = [], []
    for rec in records:
        key = stable_key(rec.get("source_sha256", ""), rec.get("page"), rec.get("bidder", ""), rec.get("allocation", ""), rec.get("reference", ""))
        (existing if session.scalar(select(HistoricalAward.id).where(HistoricalAward.stable_key == key)) else new).append({**rec, "stable_key": key})
    return {"new": new, "existing": existing}
