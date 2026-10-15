"""Deterministic local extractor: regex rules over page text, each hit carrying the page and
the sentence it was found in as evidence. Used when tender_engine is not reachable, and
always labelled extractor="local_regex_v1" with medium confidence so a reviewer knows what
produced the value. A field with no hit is reported as missing, never defaulted."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from fdre_platform.integrations.tender_engine import Candidate

EXTRACTOR = "local_regex_v1"


@dataclass(frozen=True)
class Rule:
    field_path: str
    pattern: str            # must contain a named group `v` for the value
    kind: str               # number | percent | text | bool | int
    flags: int = re.I
    first_pages: int | None = None   # restrict to the first N pages (cover sheet facts)


RULES: tuple[Rule, ...] = (
    Rule("core.identity.issuing_agency", r"(?P<v>(?:NHPC|SECI|NTPC|SJVN|NLC|GUVNL|MSEDCL|WBSEDCL)\s+(?:Limited|Ltd\.?|Renewable Energy Limited|India Limited))", "text", first_pages=5),
    Rule("core.identity.tender_number", r"(?:RfS|RFS|Tender)\s*(?:No\.?|Number)\s*[:\-]?\s*(?P<v>[A-Z0-9][A-Z0-9/_\-\.]{6,40})", "text", first_pages=8),
    Rule("sector.power.common.total_capacity_mw", r"(?:supply|procurement|selection)\s+of\s+(?P<v>\d{2,5})\s*MW\s+(?:[‘'\"]?firm|of\s+firm|FDRE|solar|wind|renewable|RE)", "number", first_pages=6),
    Rule("sector.power.common.ppa_tenure_years", r"(?:PPA|Power Purchase Agreement)[^.\n]{0,80}?(?:period|term|tenure)\s+of\s+(?P<v>\d{2})\s*\(?(?:[a-z\- ]+)?\)?\s*years", "int"),
    Rule("sector.power.fdre.assured_availability_percent", r"(?:availability|demand fulfil?ment)[^.\n]{0,120}?(?:at\s+least|minimum|not\s+less\s+than|of)\s+(?P<v>\d{2}(?:\.\d+)?)\s*%", "percent"),
    Rule("sector.power.fdre.demand_profile_structured.cuf_declared_min_pct", r"(?:annual\s+)?CUF[^.\n]{0,80}?(?:not\s+less\s+than|minimum\s+of|at\s+least)\s+(?P<v>\d{2}(?:\.\d+)?)\s*%", "percent"),
    Rule("sector.power.fdre.shortfall_compensation_multiple", r"(?P<v>\d(?:\.\d+)?)\s*(?:\(\w+\s+point\s+\w+\)\s*)?(?:times|x)\s+(?:of\s+)?(?:the\s+)?(?:PPA\s+)?tariff", "number"),
    Rule("sector.power.common.min_bid_mw", r"minimum\s+(?:bid|project)\s+capacity[^.\n]{0,40}?(?P<v>\d{2,4})\s*MW", "number"),
    Rule("sector.power.common.max_bid_mw", r"maximum\s+(?:bid\s+|project\s+)?capacity[^.\n]{0,80}?(?:bidder|company)[^.\n]{0,60}?(?P<v>\d{2,4})\s*MW", "number"),
    Rule("platform.capacity.bid_multiple_mw", r"(?:in\s+)?multiples?\s+of\s+(?P<v>\d{1,3})\s*MW", "number"),
    Rule("sector.power.fdre.storage_mandatory", r"(?P<v>coupled with energy storage|energy storage system[^.\n]{0,40}mandatory|shall\s+(?:install|have)\s+(?:an\s+)?energy storage)", "bool"),
    Rule("sector.power.common.bess_charging_rule.re_only", r"(?P<v>charg(?:ed|ing)\s+(?:only\s+)?(?:from|through|by)\s+(?:the\s+)?(?:renewable|RE)\s+(?:energy\s+)?(?:source|power|generation)s?)", "bool"),
    Rule("sector.power.fdre.demand_profile_structured.external_sourcing_max_pct", r"(?:up\s*to|upto|maximum\s+of)\s+(?P<v>\d{1,2})\s*%[^.\n]{0,80}?(?:green|other\s+RE|external|exchange|market)", "percent"),
    Rule("sector.power.common.tariff_ceiling_inr_per_kwh", r"(?:ceiling|maximum)\s+tariff[^.\n]{0,60}?(?:Rs\.?|INR|₹)\s*(?P<v>\d{1,2}(?:\.\d{1,3})?)\s*(?:/|per)\s*kWh", "number"),
    Rule("core.guarantees.emd_per_mw_inr", r"(?:EMD|Earnest\s+Money\s+Deposit)[^.\n]{0,80}?(?:Rs\.?|INR|₹)\s*(?P<v>\d{1,3}(?:,\d{2,3})*(?:\.\d+)?)\s*(?:Lakhs?|Lacs?)?\s*(?:/|per)\s*MW", "money_lakh_per_mw"),
    Rule("core.guarantees.pbg_per_mw_inr", r"(?:PBG|Performance\s+Bank\s+Guarantee)[^.\n]{0,80}?(?:Rs\.?|INR|₹)\s*(?P<v>\d{1,3}(?:,\d{2,3})*(?:\.\d+)?)\s*(?:Lakhs?|Lacs?)?\s*(?:/|per)\s*MW", "money_lakh_per_mw"),
    Rule("core.key_dates.bid_submission_deadline", r"(?:last\s+date|deadline)[^.\n]{0,60}?(?:bid\s+)?submission[^.\n]{0,40}?(?P<v>\d{1,2}[./-]\d{1,2}[./-]\d{2,4})", "text", first_pages=12),
    Rule("platform.commercial.psm_charge_inr_per_kwh", r"(?:Rs\.?|INR|₹)\s*(?P<v>0\.\d{2})\s*(?:/|per)\s*kWh[^.\n]{0,80}?(?:payment\s+security|PSM|trading\s+margin)", "number"),
)


def _sentence(text: str, start: int, end: int) -> str:
    a = max(text.rfind(".", 0, start), text.rfind("\n", 0, start)) + 1
    b = text.find(".", end)
    b = len(text) if b == -1 else b + 1
    return re.sub(r"\s+", " ", text[a:b]).strip()[:400]


def _coerce(kind: str, raw: str) -> Any:
    raw = raw.strip()
    if kind == "bool":
        return True
    if kind == "text":
        return raw
    num = float(raw.replace(",", ""))
    if kind == "int":
        return int(num)
    if kind == "money_lakh_per_mw":
        return num * 100000 if num < 1000 else num
    return num


def extract(pages: list[dict[str, Any]], *, document_id: str) -> list[Candidate]:
    """pages: [{page: int, text: str}]. Returns one candidate per rule that hits, from the
    first page where it does, with page and sentence evidence."""
    out: list[Candidate] = []
    for rule in RULES:
        rx = re.compile(rule.pattern, rule.flags)
        found = None
        for page in pages:
            if rule.first_pages and page["page"] > rule.first_pages:
                break
            m = rx.search(page["text"] or "")
            if m:
                found = (page, m)
                break
        if not found:
            continue
        page, m = found
        try:
            value = _coerce(rule.kind, m.group("v"))
        except ValueError:
            continue
        out.append(
            Candidate(
                field_path=rule.field_path, value=value, provenance="extracted", confidence=0.6, extractor=EXTRACTOR, source="local",
                evidence={"document_id": document_id, "document_version": None, "page": page["page"], "clause": None, "excerpt": _sentence(page["text"], m.start(), m.end()), "bbox": None, "resolution": "located"},
            )
        )
    return out


def page_texts(filename: str, data: bytes) -> list[dict[str, Any]]:
    """Page texts through the existing local parser (pymupdf/pypdf, docling when installed)."""
    import fdre_tender_rag as T

    _text, pages, _meta = T.extract_tender_document(filename, data, "standard")
    return [{"page": int(p["page"]), "text": p.get("text") or ""} for p in pages]
