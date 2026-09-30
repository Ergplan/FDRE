"""BESS tender intelligence: read a standalone battery storage RfS and extract its requirements.

Builds on the FDRE tender pipeline (fdre_tender_rag.py): Docling or standard text extraction
with page boundaries, clause-aware chunking and lexical retrieval, metadata, timeline, risk and
amendment detection. On top of that it extracts the BESS requirements that decide sizing and
the bid: power and energy, duration, cycles, round-trip efficiency, availability, contract
term, tariff basis and ceiling, VGF, charging responsibility, capacity maintenance
(augmentation), bid limits, securities and penalties.

Every field carries the value, how confident the match is (``high`` = explicit statement,
``medium`` = derived or a looser match, ``low`` = not found, a default is used) and the
source: page, clause and a snippet, so the bidder can check each number against the document.
"""
from __future__ import annotations

import re
from typing import Any, Callable

import fdre_tender_rag as T

NUM = r"(\d{1,3}(?:,\d{2,3})*(?:\.\d+)?|\d+(?:\.\d+)?)"
WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "eight": 8, "ten": 10, "twelve": 12,
         "fifteen": 15, "twenty": 20, "eighteen": 18, "twenty four": 24, "twenty-four": 24, "twenty five": 25, "twenty-five": 25}
WORD_NUM = r"(\d+(?:\.\d+)?|one|two|three|four|five|six|eight|ten|twelve|fifteen|eighteen|twenty(?:[- ]four|[- ]five)?)"


def _num(value: str) -> float:
    v = str(value).strip().lower()
    if v in WORDS:
        return float(WORDS[v])
    return float(v.replace(",", ""))


class _Page:
    __slots__ = ("number", "text", "clauses")

    def __init__(self, number: int, text: str):
        self.number = number
        # spaces collapsed, line breaks kept (clause headings are found at line starts)
        self.text = re.sub(r"[ \t\r\u00a0]+", " ", text or "")
        self.clauses = [(m.start(), T.clean_clause_id(m.group(1))) for m in T.CLAUSE_RE.finditer(self.text)]


def _clause_at(page: _Page, pos: int) -> str | None:
    # clause ids are located on the raw text; positions are close enough for a label
    found = None
    for start, cid in page.clauses:
        if start <= pos:
            found = cid
    return found


def _snippet(text: str, start: int, end: int, pad: int = 150) -> str:
    a = max(0, start - pad)
    b = min(len(text), end + pad)
    return ("… " if a > 0 else "") + T.normalize_space(text[a:b]) + (" …" if b < len(text) else "")


def _search(pages: list[_Page], patterns: list[str], flags=re.I):
    """First match of the first pattern that matches anywhere, in page order."""
    for pattern in patterns:
        rx = re.compile(pattern, flags)
        for page in pages:
            m = rx.search(page.text)
            if m:
                return m, page
    return None, None


ISSUERS = [
    (r"Solar Energy Corporation of India|\bSECI\b", "Solar Energy Corporation of India Limited (SECI)"),
    (r"NTPC Vidyut Vyapar Nigam|\bNVVN\b", "NTPC Vidyut Vyapar Nigam Limited (NVVN)"),
    (r"\bNTPC\b", "NTPC Limited"),
    (r"\bNHPC\b", "NHPC Limited"),
    (r"\bSJVN\b", "SJVN Limited"),
    (r"NLC India|\bNLCIL\b", "NLC India Limited"),
    (r"Gujarat Urja Vikas Nigam|\bGUVNL\b", "Gujarat Urja Vikas Nigam Limited (GUVNL)"),
    (r"Maharashtra State Electricity Distribution|\bMSEDCL\b", "Maharashtra State Electricity Distribution Co. Ltd (MSEDCL)"),
    (r"Rajasthan Urja Vikas|\bRUVITL\b|\bRUVNL\b", "Rajasthan Urja Vikas and IT Services Ltd"),
    (r"Tamil Nadu Green Energy|\bTNGECL\b", "Tamil Nadu Green Energy Corporation Ltd (TNGECL)"),
    (r"Kerala State Electricity Board|\bKSEB\b", "Kerala State Electricity Board (KSEB)"),
    (r"Power Company of Karnataka|\bPCKL\b", "Power Company of Karnataka Ltd (PCKL)"),
    (r"Andhra Pradesh|\bAPPCC\b|\bNREDCAP\b", "Andhra Pradesh (APPCC / NREDCAP)"),
]


def _issuer(text: str) -> str | None:
    head = text[:6000]
    for pattern, label in ISSUERS:
        if re.search(pattern, head, re.I):
            return label
    return None


def _field(key: str, label: str, value: Any, unit: str = "", *, confidence: str, page: _Page | None = None,
           match: re.Match | None = None, note: str = "", display: str | None = None, source: dict | None = None) -> dict:
    src = source or {}
    if page is not None and match is not None:
        src = {"page": page.number, "clause": _clause_at(page, match.start()), "snippet": _snippet(page.text, match.start(), match.end())}
    shown = display if display is not None else (f"{value:g} {unit}".strip() if isinstance(value, (int, float)) else str(value))
    return {"key": key, "label": label, "value": value, "unit": unit, "display": shown, "confidence": confidence,
            "found": confidence != "low", "note": note, **src}


def _retrieved_source(chunks, query: str) -> dict:
    hits = T.retrieve_chunks(chunks, query, top_k=1)
    if not hits:
        return {}
    h = hits[0]
    return {"page": h.meta.get("page_number"), "clause": h.meta.get("clause_id"), "snippet": h.content[:360] + ("…" if len(h.content) > 360 else "")}


# ----------------------------------------------------------------------------- field extractors

def _capacity(pages):
    """Power MW and energy MWh, from 'X MW / Y MWh' or separate statements."""
    m, p = _search(pages, [rf"{NUM}\s*MW\s*/\s*{NUM}\s*MWh", rf"{NUM}\s*MW\s*\(\s*{NUM}\s*MWh\s*\)", rf"{NUM}\s*MW\s*(?:and|&|with)\s*{NUM}\s*MWh"])
    if m:
        return (_num(m.group(1)), _num(m.group(2)), m, p, "high")
    mp, pp = _search(pages, [rf"(?:capacity|BESS|storage)[^.]{{0,80}}?{NUM}\s*MW\b(?!h)", rf"{NUM}\s*MW\b(?!h)[^.]{{0,40}}(?:BESS|battery|storage)"])
    me, pe = _search(pages, [rf"{NUM}\s*MWh"])
    power = _num(mp.group(1)) if mp else None
    energy = _num(me.group(1)) if me else None
    return (power, energy, mp or me, pp or pe, "medium" if (mp or me) else "low")


def extract_requirements(pages_raw: list[dict], chunks, name: str) -> list[dict]:
    pages = [_Page(p.get("page", i + 1), p.get("text", "")) for i, p in enumerate(pages_raw)]
    fields: list[dict] = []
    add = fields.append

    power, energy, m, p, conf = _capacity(pages)
    add(_field("powerMw", "Contracted power", power if power else 250.0, "MW", confidence=conf if power else "low", page=p, match=m,
               source=None if power else _retrieved_source(chunks, "BESS capacity MW MWh storage")))
    add(_field("energyMwh", "Contracted energy", energy if energy else 500.0, "MWh", confidence=conf if energy else "low", page=p, match=m,
               note="Energy the BESS must deliver at the delivery point in every cycle" if energy else "Not found; 2 hours of the power is assumed",
               source=None if energy else _retrieved_source(chunks, "MWh energy storage capacity")))

    md, pd = _search(pages, [rf"\(?\s*{WORD_NUM}\s*(?:\(\s*[\w\s-]{{1,20}}\)\s*)?[- ]?hours?\s*\)?\s*(?:of\s*)?(?:storage|duration|discharge|BESS|battery)",
                             rf"(?:duration|discharge period)[^.]{{0,40}}?{WORD_NUM}\s*(?:\(\s*[\w\s-]{{1,20}}\)\s*)?hours?"])
    p_mw = fields[0]["value"]
    e_mwh = fields[1]["value"]
    if md:
        add(_field("durationH", "Discharge duration", _num(md.group(1)), "h", confidence="high", page=pd, match=md))
    else:
        add(_field("durationH", "Discharge duration", round(e_mwh / p_mw, 2) if p_mw else 2.0, "h", confidence="medium" if power and energy else "low",
                   note="Derived as energy ÷ power", source={k: fields[1].get(k) for k in ("page", "clause", "snippet")} if energy else {}))

    mc, pc = _search(pages, [rf"{WORD_NUM}\s*(?:\(\s*[\w\s-]{{1,20}}\)\s*)?(?:full\s+|complete\s+|operational\s+)?(?:charge[- /]discharge\s+|charging[- /]discharging\s+)?cycles?\s*(?:per|a|in a|each)\s*day",
                             rf"cycles?\s*per\s*day[^.]{{0,30}}?{WORD_NUM}"])
    add(_field("cyclesPerDay", "Cycles per day", _num(mc.group(1)) if mc else 1.0, "cycles/day", confidence="high" if mc else "low", page=pc, match=mc,
               source=None if mc else _retrieved_source(chunks, "cycles per day charge discharge cycle")))

    my, py = _search(pages, [rf"{NUM}\s*(?:full\s+)?cycles?\s*(?:per|in a|each|a)\s*(?:year|annum)", rf"(?:maximum|up to)\s*(?:of\s*)?{NUM}\s*cycles"])
    cycles_day = fields[-1]["value"]
    add(_field("annualCycles", "Cycles per year", _num(my.group(1)) if my else round(cycles_day * 365), "cycles/yr",
               confidence="high" if my else "medium" if mc else "low", page=py, match=my,
               note="" if my else "Derived as cycles per day × 365"))

    mr, pr = _search(pages, [rf"round[- ]?trip\s+efficiency[^%]{{0,160}}?(?:not\s+(?:be\s+)?less\s+than|at\s+least|minimum(?:\s+of)?|≥|>=|of)\s*{NUM}\s*%",
                             rf"(?:RTE|AC[- ]AC efficiency)[^%]{{0,120}}?{NUM}\s*%", rf"{NUM}\s*%\s*(?:AC[- ]to[- ]AC\s+)?round[- ]?trip"])
    add(_field("minRte", "Minimum round-trip efficiency", _num(mr.group(1)) / 100 if mr else 0.85, "", confidence="high" if mr else "low", page=pr, match=mr,
               display=f"{_num(mr.group(1)):g}%" if mr else "85% (default)", source=None if mr else _retrieved_source(chunks, "round trip efficiency RTE")))

    ma, pa = _search(pages, [rf"(?:system\s+|annual\s+|monthly\s+|guaranteed\s+)?availability[^%]{{0,160}}?(?:not\s+(?:be\s+)?less\s+than|at\s+least|minimum(?:\s+of)?|≥|>=|of)\s*{NUM}\s*%",
                             rf"{NUM}\s*%\s*(?:system\s+|annual\s+|monthly\s+)?availability"])
    add(_field("availability", "Minimum availability", _num(ma.group(1)) / 100 if ma else 0.95, "", confidence="high" if ma else "low", page=pa, match=ma,
               display=f"{_num(ma.group(1)):g}%" if ma else "95% (default)", source=None if ma else _retrieved_source(chunks, "availability guaranteed monthly annual")))
    basis = "monthly" if ma and re.search(r"(?i)month", pa.text[max(0, ma.start() - 80):ma.end() + 80]) else "annual"
    add(_field("availabilityBasis", "Availability measured", basis, "", confidence="medium" if ma else "low", page=pa, match=ma))

    mt, pt = _search(pages, [rf"(?:term|period|tenure|duration)\s+of\s+(?:the\s+)?(?:BESPA|BESSPA|ESPA|ESA|agreement|contract|PPA)[^.]{{0,80}}?{WORD_NUM}\s*(?:\(\s*[\w\s-]{{1,20}}\)\s*)?years",
                             rf"{WORD_NUM}\s*(?:\(\s*[\w\s-]{{1,20}}\)\s*)?years\s+from\s+(?:the\s+)?(?:date\s+of\s+)?(?:S?COD|commercial operation)",
                             rf"(?:BESPA|BESSPA|ESPA|agreement)[^.]{{0,80}}?(?:for|period of)\s+{WORD_NUM}\s*(?:\(\s*[\w\s-]{{1,20}}\)\s*)?years"])
    add(_field("contractYears", "Contract term", _num(mt.group(1)) if mt else 12.0, "years", confidence="high" if mt else "low", page=pt, match=mt,
               source=None if mt else _retrieved_source(chunks, "term of agreement years from COD")))

    ms, pss = _search(pages, [rf"(?:SCOD|scheduled commercial operation date|scheduled commissioning)[^.]{{0,160}}?{WORD_NUM}\s*(?:\(\s*[\w\s-]{{1,20}}\)\s*)?months",
                              rf"commission(?:ed|ing)?[^.]{{0,80}}?within\s+{WORD_NUM}\s*(?:\(\s*[\w\s-]{{1,20}}\)\s*)?months"])
    add(_field("scodMonths", "Commissioning (SCOD)", _num(ms.group(1)) if ms else 18.0, "months", confidence="high" if ms else "low", page=pss, match=ms))

    # tariff basis and ceiling
    mb, pb = _search(pages, [r"(?:Rs\.?|INR|₹)\s*/?\s*(?:per\s+)?MW\s*/?\s*(?:per\s+)?month", r"per\s+MW\s+per\s+month", r"/MW/month",
                             r"(?:Rs\.?|INR|₹)\s*/?\s*(?:per\s+)?kWh", r"per\s+kWh"])
    per_month = bool(mb and re.search(r"(?i)month", mb.group(0)))
    add(_field("tariffBasis", "Tariff basis", "capacity" if (per_month or not mb) else "energy", "", confidence="high" if mb else "low", page=pb, match=mb,
               display="Capacity charge, ₹/MW/month" if (per_month or not mb) else "Energy charge, ₹/kWh"))
    mcl, pcl = _search(pages, [rf"(?:ceiling|maximum|upper\s+limit\s+of\s+the)\s+(?:tariff|capacity\s+charge|bid\s+tariff)[^.]{{0,80}}?(?:Rs\.?|INR|₹)\s*{NUM}\s*(lakh|lac)?",
                               rf"(?:Rs\.?|INR|₹)\s*{NUM}\s*(lakh|lac)?\s*/?\s*(?:per\s+)?MW\s*/?\s*(?:per\s+)?month[^.]{{0,60}}(?:ceiling|maximum)"])
    if mcl:
        val = _num(mcl.group(1)) * (1e5 if mcl.group(2) else 1)
        add(_field("ceilingTariff", "Ceiling tariff", val, "₹/MW/month", confidence="high", page=pcl, match=mcl, display=f"₹{val / 1e5:.2f} lakh/MW/month"))
    else:
        add(_field("ceilingTariff", "Ceiling tariff", None, "₹/MW/month", confidence="low", display="Not stated", source=_retrieved_source(chunks, "ceiling tariff maximum capacity charge")))

    mv, pv = _search(pages, [rf"(?:VGF|viability\s+gap\s+funding)[^.]{{0,200}}?(?:Rs\.?|INR|₹)\s*{NUM}\s*(lakh|lac|crore|cr)\s*/?\s*(?:per\s+)?MWh",
                             rf"(?:VGF|viability\s+gap\s+funding)[^.]{{0,200}}?{NUM}\s*%\s*of\s+(?:the\s+)?(?:capital|project)\s+cost"])
    if mv and mv.lastindex and mv.lastindex >= 2 and mv.group(2):
        unit = mv.group(2).lower()
        lakh = _num(mv.group(1)) * (100 if unit in ("crore", "cr") else 1)
        add(_field("vgfLakhPerMwh", "VGF support", lakh, "lakh/MWh", confidence="high", page=pv, match=mv, display=f"₹{lakh:g} lakh/MWh"))
    elif mv:
        add(_field("vgfPct", "VGF support", _num(mv.group(1)) / 100, "", confidence="high", page=pv, match=mv, display=f"{_num(mv.group(1)):g}% of capital cost"))
    else:
        mvv, pvv = _search(pages, [r"viability\s+gap\s+funding|\bVGF\b"])
        add(_field("vgfLakhPerMwh", "VGF support", 0.0, "lakh/MWh", confidence="medium" if mvv else "low", page=pvv, match=mvv,
                   display="Mentioned; amount not found" if mvv else "None found"))

    mch, pch = _search(pages, [r"charging\s+(?:power|energy|electricity)[^.]{0,120}?(?:provided|arranged|supplied|scheduled|borne)\s+by\s+(?:the\s+)?(procurer|buyer|discom|utility|BESSD|developer|seller|SPD|BESPD)",
                               r"(procurer|buyer|developer|BESSD|BESPD)\s+shall\s+(?:provide|arrange|supply)\s+(?:the\s+)?charging"])
    who = (mch.group(1).lower() if mch else "procurer")
    by_procurer = who in ("procurer", "buyer", "discom", "utility")
    add(_field("chargingBy", "Charging energy", "procurer" if by_procurer else "developer", "", confidence="high" if mch else "low", page=pch, match=mch,
               display="Provided by the procurer" if by_procurer else "Arranged by the developer"))

    mm, pm = _search(pages, [r"(?:maintain|ensure|guarantee)[^.]{0,80}?(?:contracted|rated|installed)\s+(?:capacity|energy)[^.]{0,120}?(?:throughout|entire|full|term|duration)",
                             r"augment(?:ation)?[^.]{0,160}?(?:developer|BESSD|seller|own\s+cost)"])
    add(_field("maintainCapacity", "Capacity maintained for the full term", True, "", confidence="high" if mm else "medium", page=pm, match=mm,
               display="Yes: augmentation at the developer's cost" if mm else "Assumed (standard); check the clause",
               source=None if mm else _retrieved_source(chunks, "augmentation degradation maintain capacity")))

    mv2, pv2 = _search(pages, [rf"{NUM}\s*kV"])
    add(_field("connectionKv", "Connection voltage", _num(mv2.group(1)) if mv2 else None, "kV", confidence="high" if mv2 else "low", page=pv2, match=mv2,
               display=f"{_num(mv2.group(1)):g} kV" if mv2 else "Not stated"))
    ml, pl = _search(pages, [r"(?:at|near)\s+(?:the\s+)?([A-Z][\w\-. ]{2,40}?)\s+(?:\d{2,3}\s*/\s*\d{2,3}\s*kV\s+)?(?:sub-?station|S/S|GSS|pooling station)"], flags=0)
    add(_field("location", "Location", ml.group(1).strip() if ml else "Not stated", "", confidence="high" if ml else "low", page=pl, match=ml))

    mmn, pmn = _search(pages, [rf"minimum\s+(?:bid\s+)?(?:capacity|quantum)[^.]{{0,60}}?{NUM}\s*MW(?!h)"])
    add(_field("minBidMw", "Minimum bid", _num(mmn.group(1)) if mmn else None, "MW", confidence="high" if mmn else "low", page=pmn, match=mmn,
               display=f"{_num(mmn.group(1)):g} MW" if mmn else "Not stated"))
    mmx, pmx = _search(pages, [rf"maximum\s+(?:bid\s+)?(?:capacity|quantum)[^.]{{0,80}}?{NUM}\s*MW(?!h)"])
    add(_field("maxBidMw", "Maximum bid", _num(mmx.group(1)) if mmx else None, "MW", confidence="high" if mmx else "low", page=pmx, match=mmx,
               display=f"{_num(mmx.group(1)):g} MW" if mmx else "Not stated"))

    for key, label, words in (("emdLakhPerMw", "Bid security (EMD)", r"(?:EMD|earnest\s+money|bid\s+security|bid\s+bond)"),
                              ("pbgLakhPerMw", "Performance security (PBG)", r"(?:PBG|performance\s+(?:bank\s+)?(?:guarantee|security))")):
        mg, pg = _search(pages, [rf"{words}[^.]{{0,160}}?(?:Rs\.?|INR|₹)\s*{NUM}\s*(lakh|lac|crore|cr)?\s*/?\s*(?:per\s+)?MW(?!h)",
                                 rf"{words}[^.]{{0,160}}?(?:Rs\.?|INR|₹)\s*{NUM}\s*(lakh|lac|crore|cr)?\s*/?\s*(?:per\s+)?MWh"])
        if mg:
            unit = (mg.group(2) or "").lower()
            lakh = _num(mg.group(1)) * (100 if unit in ("crore", "cr") else 1 if unit else 1e-5)
            per = "MWh" if re.search(r"(?i)MWh", mg.group(0)) else "MW"
            add(_field(key, label, lakh, f"lakh/{per}", confidence="high", page=pg, match=mg, display=f"₹{lakh:g} lakh/{per}"))
        else:
            add(_field(key, label, None, "lakh/MW", confidence="low", display="Not stated", source=_retrieved_source(chunks, f"{label} amount per MW")))

    for key, label, query, pats in (
        ("availabilityPenalty", "Availability shortfall penalty", "availability shortfall penalty compensation",
         [r"(?:shortfall|below|less\s+than)[^.]{0,80}availability[\s\S]{0,300}?\.(?=\s|$)", r"availability[^.]{0,120}(?:penalty|compensation|deduction|liquidated)[\s\S]{0,260}?\.(?=\s|$)"]),
        ("rtePenalty", "RTE shortfall penalty", "round trip efficiency shortfall penalty",
         [r"(?:round[- ]?trip\s+efficiency|RTE)[^.]{0,160}(?:penalty|compensat|deduct|shortfall|liquidated)[\s\S]{0,260}?\.(?=\s|$)"]),
    ):
        mq, pq = _search(pages, pats)
        text = T.normalize_space(mq.group(0))[:260] if mq else "Not found; review the penalty clauses"
        add(_field(key, label, text, "", confidence="high" if mq else "low", page=pq, match=mq, display=text,
                   source=None if mq else _retrieved_source(chunks, query)))
    return fields


def parse_bess_tender(name: str, payload: bytes, parser: str = "auto") -> dict[str, Any]:
    text, pages, extraction = T.extract_tender_document(name, payload, parser)
    chunks = T.split_tender_chunks(name, text)
    normalized = T.normalize_space(text)
    requirements = extract_requirements(pages, chunks, name)
    found = sum(1 for f in requirements if f["found"])
    is_bess = bool(re.search(r"(?i)battery\s+energy\s+storage|\bBESS\b|energy\s+storage\s+system", normalized))
    metadata = T._metadata(normalized, name)
    metadata["issuer"] = _issuer(normalized) or metadata.get("issuer")
    return {
        "source_name": name,
        "title": T._tender_title(normalized),
        "metadata": metadata,
        "is_bess": is_bess,
        "requirements": requirements,
        "found": found,
        "total": len(requirements),
        "timeline": T._timeline_rows(chunks, normalized),
        "risk_flags": T._risk_flags(chunks, text),
        "amendments": T._amendment_rows(name, chunks, normalized.lower()),
        "extraction": {**extraction, "pages": len(pages), "chunks": len(chunks)},
        "warnings": ([] if is_bess else ["This document does not look like a battery storage tender; check the extracted values."])
        + ([extraction["warning"]] if extraction.get("warning") else []),
    }
