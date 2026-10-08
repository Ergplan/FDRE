"""Rules mode: deterministic extractors for the headline fields, used when no model is
available (no OPENAI_API_KEY or ANTHROPIC_API_KEY, a DOCX or text upload, or mode=rules).

Not from tender_engine: written for FDRE, reusing number patterns and issuer names from
fdre_bess_tender. Every value comes with a verbatim quote: the page's own words in order,
with each run of whitespace (line breaks included) written as one space, 5 to 40 words,
cut at sentence or table-cell boundaries, and always containing the matched value. The
quotes then go through the same resolver, coercion and rules as a model's answer.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any

import fdre_bess_tender as BESS

from tender_intel.resolver import PageText

CONFIDENCE = 0.6
CONFLICT_CONFIDENCE = 0.4
MIN_QUOTE_WORDS = 5
MAX_QUOTE_WORDS = 40
NOT_READ = "Not read in rules mode; set OPENAI_API_KEY or ANTHROPIC_API_KEY for the full reading."
NOT_FOUND = "The rules reader found no statement of this on the pages; check the document."
# How many pages from the front the identity and date extractors look at.
FRONT_PAGES = 40

NUM = r"(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
_UNITS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}  # fmt: skip
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60}
_UNIT_WORDS = "|".join(sorted(_UNITS, key=len, reverse=True))
_TEN_WORDS = "|".join(_TENS)
WORD = rf"(?:(?:{_TEN_WORDS})(?:[\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?|{_UNIT_WORDS})"
NUMW = rf"(\d+(?:\.\d+)?|{WORD})"
# A number may be followed by itself in words: "24 (Twenty Four) months".
PAREN = r"(?:\s*\([^)]{1,30}\))?"
MULT = r"(\d+(?:\.\d+)?|one\s+and\s+(?:a\s+)?half|(?:one|two|three|four|five)(?:\s+and\s+(?:a\s+)?half)?)"
DATE = (
    r"(\d{1,2}[./-]\d{1,2}[./-]\d{4}"
    r"|\d{1,2}(?:st|nd|rd|th)?[\s\-.,]+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?[\s\-.,]+\d{4})"
)
TIME_AFTER = r"(?:\s*\(?\s*(?:up\s*to\s*|upto\s*)?\d{1,2}[:.]\d{2}\s*(?:hrs?\.?|hours|IST)?\s*\)?)?"
INR = r"(?:Rs\.?|INR|₹)"
STATES = [
    "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat",
    "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh",
    "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Orissa", "Punjab",
    "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand",
    "West Bengal", "Jammu and Kashmir", "Ladakh", "Delhi", "Puducherry", "Chandigarh",
]  # fmt: skip
STATE = r"(" + "|".join(s.replace(" ", r"\s+") for s in STATES) + r")"
_GENERIC_SITES = {"ists", "ctu", "stu", "pooling", "delivery", "interconnection", "grid", "the", "existing", "nearest", "same", "common", "any", "a", "said", "such", "this", "that", "respective", "concerned"}
_ABBREVIATIONS = {
    "rs.", "no.", "nos.", "dt.", "viz.", "i.e.", "e.g.", "etc.", "sr.", "sl.", "s.", "hrs.", "ltd.", "pvt.",
    "co.", "govt.", "mr.", "ms.", "dr.", "vs.", "w.e.f.", "approx.", "max.", "min.", "cl.", "para.", "fig.",
    "ref.", "inr.", "st.", "nos", "u/s.", "sec.", "art.", "vol.", "dept.", "addl.", "jt.", "m/s.",
}  # fmt: skip


def number(text: str) -> float | int:
    """A number from digits (thousands separators removed) or words."""
    raw = " ".join(text.lower().replace("-", " ").split())
    if raw in _UNITS:
        return _UNITS[raw]
    parts = raw.split()
    if parts and parts[0] in _TENS:
        return _TENS[parts[0]] + (_UNITS.get(parts[1], 0) if len(parts) > 1 else 0)
    if "half" in raw:
        whole = number(parts[0]) if parts and parts[0] != "half" else 0
        return whole + 0.5
    value = float(raw.replace(",", ""))
    return int(value) if value.is_integer() else value


def collapse(text: str) -> str:
    return " ".join(text.split())


# ----------------------------------------------------------------------------- quotes


def _words(text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in re.finditer(r"\S+", text)]


def _ends_sentence(token: str) -> bool:
    stripped = token.rstrip(")\"'’”]").lstrip("(\"'‘“[")
    if stripped.endswith(";") or stripped in {".", ":", "•"}:
        return True
    if not stripped.endswith("."):
        return False
    low = stripped.lower()
    if low in _ABBREVIATIONS or len(stripped) <= 2:
        return False
    if re.fullmatch(r"\(?(?:\d+(?:\.\d+)*|[ivxl]{1,4})\.", low):  # clause numbers: "3.4.", "iv."
        return False
    return not re.fullmatch(r"\(?[a-z]\.", low)  # list markers: "a."


def _break_between(text: str, left_end: int, right_start: int) -> bool:
    """Two words separated by a blank line or a block break (two line breaks)."""
    return text.count("\n", left_end, right_start) >= 2


def make_quote(text: str, start: int, end: int, mode: str = "sentence") -> str:
    """The page's words around text[start:end], whitespace collapsed: the sentence (or
    table cell) holding the span in "sentence" mode, the span itself in "span" mode;
    5 to 40 words either way, always covering the whole span."""
    words = _words(text)
    if not words:
        return collapse(text[start:end])
    first = next((i for i, (_, e) in enumerate(words) if e > start), len(words) - 1)
    last = max(first, max((i for i, (s, _) in enumerate(words) if s < end), default=first))
    a, b = first, last
    if mode == "sentence":
        while a > 0 and not _ends_sentence(text[words[a - 1][0] : words[a - 1][1]]) and not _break_between(
            text, words[a - 1][1], words[a][0]
        ):
            a -= 1
        while (
            b < len(words) - 1
            and not _ends_sentence(text[words[b][0] : words[b][1]])
            and not _break_between(text, words[b][1], words[b + 1][0])
        ):
            b += 1
    else:
        # A table cell or a short line: take the whole lines the span is on.
        while a > 0 and "\n" not in text[words[a - 1][1] : words[a][0]] and b - a + 1 < MAX_QUOTE_WORDS:
            a -= 1
        while b < len(words) - 1 and "\n" not in text[words[b][1] : words[b + 1][0]] and b - a + 1 < MAX_QUOTE_WORDS:
            b += 1
    if b - a + 1 > MAX_QUOTE_WORDS:
        span = last - first + 1
        if span >= MAX_QUOTE_WORDS:
            a, b = first, first + MAX_QUOTE_WORDS - 1
        else:
            slack = MAX_QUOTE_WORDS - span
            a = max(a, first - slack // 2)
            b = min(b, a + MAX_QUOTE_WORDS - 1)
            a = max(a, b - MAX_QUOTE_WORDS + 1)
    grow_right = True
    while b - a + 1 < MIN_QUOTE_WORDS and (a > 0 or b < len(words) - 1):
        if (grow_right and b < len(words) - 1) or a == 0:
            b += 1
        else:
            a -= 1
        grow_right = not grow_right
    return collapse(text[words[a][0] : words[b][1]])


def sentence_bounds(text: str, start: int, end: int) -> tuple[int, int]:
    """Character range of the sentence (or table cell) holding text[start:end]."""
    words = _words(text)
    if not words:
        return start, end
    first = next((i for i, (_, e) in enumerate(words) if e > start), len(words) - 1)
    last = max(first, max((i for i, (s, _) in enumerate(words) if s < end), default=first))
    a, b = first, last
    while a > 0 and not _ends_sentence(text[words[a - 1][0] : words[a - 1][1]]) and not _break_between(
        text, words[a - 1][1], words[a][0]
    ):
        a -= 1
    while (
        b < len(words) - 1
        and not _ends_sentence(text[words[b][0] : words[b][1]])
        and not _break_between(text, words[b][1], words[b + 1][0])
    ):
        b += 1
    return words[a][0], words[b][1]


# ----------------------------------------------------------------------------- hits


@dataclass
class Hit:
    """One statement of a value: the value, where it is printed and how to quote it."""

    value: Any
    page: int
    start: int
    end: int
    key: Any = None
    note: str = ""
    mode: str = "sentence"
    quote: str = ""

    def __post_init__(self) -> None:
        if self.key is None:
            self.key = _key(self.value)


@dataclass
class RuleDraft:
    value: Any
    confidence: float
    rationale: str
    # (document page number, quote)
    quotes: list[tuple[int, str]] = field(default_factory=list)


def _key(value: Any) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return round(float(value), 6)
    if isinstance(value, list):
        return tuple(sorted(str(v).lower() for v in value))
    return collapse(str(value)).lower()


def _iter(
    pages: list[PageText], pattern: str, flags: int = re.I, limit: int | None = None
) -> Iterator[tuple[PageText, re.Match[str]]]:
    rx = re.compile(pattern, flags)
    for page in pages[:limit] if limit else pages:
        if not page.text:
            continue
        for match in rx.finditer(page.text):
            yield page, match


def _quote_of(page_text: dict[int, str], hit: Hit) -> str:
    if not hit.quote:
        hit.quote = make_quote(page_text[hit.page], hit.start, hit.end, hit.mode)
    return hit.quote


def choose(hits: list[Hit], page_text: dict[int, str], describe: Callable[[Any], str] | None = None) -> RuleDraft | None:
    """The value printed most often (the earliest on a tie), with the quote of its first
    statement. Other values lower the confidence and are named in the rationale."""
    if not hits:
        return None
    groups: dict[Any, list[Hit]] = {}
    for hit in hits:
        groups.setdefault(hit.key, []).append(hit)
    ordered = sorted(groups.values(), key=lambda group: (-len(group), hits.index(group[0])))
    best = ordered[0][0]
    shown = describe or (lambda value: str(value))
    pages_of = sorted({h.page for h in ordered[0]})
    rationale = f"Read by the rules reader from page {best.page}"
    if len(pages_of) > 1:
        rationale += f" (also printed on page{'s' if len(pages_of) > 2 else ''} {', '.join(str(p) for p in pages_of if p != best.page)})"
    rationale += "."
    if best.note:
        rationale += f" {best.note}"
    confidence = CONFIDENCE
    if len(ordered) > 1:
        confidence = CONFLICT_CONFIDENCE
        others = "; ".join(f"{shown(group[0].value)} (p.{group[0].page})" for group in ordered[1:4])
        rationale += f" Other values were also printed: {others}. Check which one governs."
    return RuleDraft(best.value, confidence, rationale, [(best.page, _quote_of(page_text, best))])


def _in_sentence(page: PageText, match: re.Match[str], needle: str) -> bool:
    start, end = sentence_bounds(page.text, match.start(), match.end())
    return re.search(needle, page.text[start:end], re.I) is not None


_EXAMPLE = r"e\.\s?g\.|for\s+example|for\s+instance|illustrat|assum(?:e|ing)|deemed\s+to\s+be|\bif\s+the\b[^.;]{0,80}\bis\s+\d"


def _example(
    page: PageText, match: re.Match[str] | tuple[int, int], before: int = 0, previous: PageText | None = None
) -> bool:
    """Whether the match sits in a worked example, an illustration or an assumption,
    which print numbers that are not the tender's terms. With `previous`, a sentence
    that starts near the top of the page is read with the foot of the previous page."""
    start_, end_ = (match.start(), match.end()) if isinstance(match, re.Match) else match
    start, end = sentence_bounds(page.text, start_, end_)
    context = page.text[max(0, start - before) : end]
    if previous is not None and start < 400:
        context = previous.text[-400:] + " " + context
    return re.search(_EXAMPLE, context, re.I) is not None


# ----------------------------------------------------------------------------- identity

_TITLE_START = re.compile(
    r"(?:Request\s+for\s+(?:Selection|Proposal|Qualification)|Notice\s+Inviting\s+Tender|Tender\s+Document|Bid\s+Document|Bidding\s+Document)\b",
    re.I,
)
_TITLE_STOP = re.compile(r"^\s*(?:RfS|RfP|RfQ|NIT|Tender|Ref|Page|Dated|Issued|Date|\(|Doc|Bid\s+No|No\.)", re.I)


def _title(pages: list[PageText]) -> list[Hit]:
    for page in pages[:2]:
        match = _TITLE_START.search(page.text)
        if not match:
            continue
        line_start = page.text.rfind("\n", 0, match.start()) + 1
        lines_end = match.start()
        position = line_start
        count = 0
        for line in page.text[line_start:].split("\n"):
            if count and (not line.strip() or _TITLE_STOP.match(line)):
                break
            position += len(line) + 1
            if line.strip():
                lines_end = position - 1
            count += 1
            if len(collapse(page.text[match.start() : lines_end]).split()) >= MAX_QUOTE_WORDS or count >= 8:
                break
        value = collapse(page.text[match.start() : lines_end])
        words = value.split()
        if len(words) > MAX_QUOTE_WORDS:
            value = " ".join(words[:MAX_QUOTE_WORDS])
        hit = Hit(value, page.page_no, match.start(), match.start() + 1, mode="span")
        hit.quote = value if len(value.split()) >= MIN_QUOTE_WORDS else make_quote(page.text, match.start(), lines_end, "span")
        return [hit]
    return []


def _issuing_agency(pages: list[PageText]) -> list[Hit]:
    hits = []
    pattern = (
        r"issued\s+by\s*:?\s*([A-Z][A-Za-z.&\-\s]{2,120}?(?:Limited|Ltd\.?|Corporation|Nigam|Board|Authority|Agency)"
        r"(?:\s*\([A-Z]{2,12}\))?)"
    )
    for page, m in _iter(pages, pattern, re.I, 3):
        hits.append(Hit(collapse(m.group(1)), page.page_no, m.start(), m.end(), mode="span"))
    if hits:
        return hits[:1]
    best: tuple[int, int, str, PageText, re.Match[str]] | None = None
    for page in pages[:2]:
        for pattern, label in BESS.ISSUERS:
            m = re.search(pattern, page.text, re.I)
            if m and (best is None or (page.page_no, m.start()) < (best[0], best[1])):
                best = (page.page_no, m.start(), label, page, m)
    if best:
        _, _, label, page, m = best
        return [Hit(label, page.page_no, m.start(), m.end(), note=f"The page names {collapse(m.group(0))}.", mode="span")]
    return []


def _clean_number(raw: str) -> str:
    value = re.split(r"(?i)\.?\s*dated\b|\.?dated", raw)[0]
    return value.rstrip(".,;:)(").strip()


def _tender_number(pages: list[PageText]) -> list[Hit]:
    hits = []
    pattern = (
        r"(?:\b(?:RfS|RfP|RfQ|NIT|IFB|Tender|Bid)\s*(?:ID|Ref(?:erence)?\.?|Reference)?\s*(?:No\.?|Number|ID)"
        r"|\bTender\s+ID)[ \t]*[:.\-–—]?[ \t]*\n?[ \t]*([A-Z0-9][A-Za-z0-9/_\-.()&]{4,80})"
    )
    for page, m in _iter(pages, pattern, re.I, FRONT_PAGES):
        value = _clean_number(m.group(1))
        if value.endswith(("/", "-")) or page.text[m.start(1) + len(value) : m.start(1) + len(value) + 1] in ("…", "_"):
            continue  # a blank form: "RfQ No. WBSEDCL/RE-RTC/26-27/….dated"
        if len(value) < 5 or not re.search(r"\d", value) or value.lower().startswith(("dated", "date")):
            continue
        hits.append(Hit(value, page.page_no, m.start(), m.start(1) + len(value), mode="span"))
    return hits


_TYPE_PHRASES = [
    r"Firm\s*(?:&|and)\s*Dispatchable(?:\s+RE)?(?:\s+power)?",
    r"Round[\s-]+the[\s-]+Clock(?:\s*\(RTC\))?(?:\s+RE)?(?:\s+power)?",
    r"\bRE[\s-]+RTC(?:\s+power)?",
    r"Assured\s+Peak(?:\s+Power)?",
    r"(?:Standalone\s+)?Battery\s+Energy\s+Storage\s+System",
    r"Wind[\s-]+Solar\s+Hybrid(?:\s+Power)?",
    r"Engineering,?\s+Procurement\s+and\s+Construction",
    r"Tariff\s+Based\s+Competitive\s+Bidding\s+for\s+Transmission",
]


def _type_as_stated(pages: list[PageText]) -> list[Hit]:
    for page in pages[:5]:
        found = []
        for pattern in _TYPE_PHRASES:
            m = re.search(pattern, page.text, re.I)
            if m:
                found.append(m)
        if found:
            m = min(found, key=lambda x: x.start())
            value = collapse(m.group(0)).strip("‘’'\"")
            return [Hit(value, page.page_no, m.start(), m.end(), mode="span")]
    return []


# ----------------------------------------------------------------------------- dates


def _date_hits(pages: list[PageText], labels: str, limit: int = FRONT_PAGES, exclude: str | None = None) -> list[Hit]:
    hits = []
    for page, m in _iter(pages, rf"(?:{labels})[^0-9]{{0,80}}?{DATE}{TIME_AFTER}", re.I, limit):
        if exclude and re.search(exclude, m.group(0), re.I):
            continue
        hits.append(Hit(collapse(m.group(1)), page.page_no, m.start(), m.end(), key=_date_key(m.group(1)), mode="span"))
    return hits


def _date_key(raw: str) -> str:
    from tender_intel.values import _date

    try:
        return _date(collapse(raw), None)
    except ValueError:
        return collapse(raw).lower()


def _bid_deadline(pages: list[PageText]) -> list[Hit]:
    labels = (
        r"online\s+bid\s+submission\s+(?:closing|end)\s+date"
        r"|(?:last|closing|due)\s+date[^\n.]{0,30}?(?:online\s+)?(?:bid\s+submission|submission\s+of\s+(?:the\s+)?(?:online\s+)?(?:bids?|response|offers?|proposals?))"
        r"|bid\s+submission\s+(?:closing|end|last)\s+date|bid\s+submission\s+close|bid\s+due\s+date"
    )
    return _date_hits(pages, labels, exclude=r"offline|start")


def _pre_bid(pages: list[PageText]) -> list[Hit]:
    return _date_hits(pages, r"pre[\s-]*bid\s+(?:meeting|conference)")


def _nit_date(pages: list[PageText]) -> list[Hit]:
    hits = _date_hits(
        pages,
        r"publishing\s+date|date\s+of\s+(?:issue|publication|publishing)|(?:issue|publication)\s+date|NIT\s+date|start\s+of\s+e[\s-]?tender",
    )
    for page, m in _iter(pages, rf"\b(?:RfS|RfP|RfQ|NIT)\s*No\.?[^\n]{{0,70}}?\n?\s*dated\s*:?\s*{DATE}", re.I, FRONT_PAGES):
        hits.append(Hit(collapse(m.group(1)), page.page_no, m.start(), m.end(), key=_date_key(m.group(1)), mode="span"))
    return hits


def _query_deadline(pages: list[PageText]) -> list[Hit]:
    return _date_hits(pages, r"last\s+date\s+(?:of|for)\s+(?:receipt\s+of\s+|receiving\s+|submission\s+of\s+|sending\s+)?(?:queries|clarifications?)")


def _era_date(pages: list[PageText]) -> list[Hit]:
    return _date_hits(pages, r"e[\s-]*reverse\s+auction(?:\s+date)?")


def _query_response(pages: list[PageText]) -> list[Hit]:
    return _date_hits(pages, r"response\s+to\s+(?:the\s+)?(?:queries|clarifications?)")


def _document_sale_end(pages: list[PageText]) -> list[Hit]:
    return _date_hits(pages, r"last\s+date\s+(?:for|of)\s+(?:procurement|purchase|sale|download(?:ing)?)\s+of\s+(?:the\s+)?(?:tender|bid(?:ding)?|RfS|RfP)\s+document")


def _loa_date(pages: list[PageText]) -> list[Hit]:
    return _date_hits(pages, r"(?:placement|issue|issuance)\s+of\s+(?:the\s+)?(?:LOA|LoA|letter\s+of\s+award)")


def _ppa_execution(pages: list[PageText]) -> list[Hit]:
    return _date_hits(pages, r"(?:PPA|power\s+purchase\s+agreement)\s+(?:execution|signing)|(?:execution|signing)\s+of\s+(?:the\s+)?PPA")


def _greenshoe_offer(pages: list[PageText]) -> list[Hit]:
    """The date before which the greenshoe is offered: "offered ... at least 30 days prior to 30.09.2027"."""
    hits = []
    for page, m in _iter(pages, rf"green\s*-?\s*shoe[^;]{{0,200}}?offered[^;]{{0,80}}?(?:prior\s+to|before)\s*{DATE2}"):
        try:
            value, note = _iso_date(m.group(1))
        except ValueError:
            continue
        hits.append(Hit(value, page.page_no, m.start(1), m.end(1), note=note))
    return hits


def _opening_date(pages: list[PageText]) -> list[Hit]:
    labels = (
        r"(?:techno[\s-]*commercial|technical)\s+bid\s+opening|opening\s+of\s+(?:techno[\s-]*commercial|technical)\s+bids?"
        r"|opening:?\s*date,?\s+time\s*&\s*venue\s+of[^0-9]{0,40}?technical\s+bid"
    )
    return _date_hits(pages, labels)


# ----------------------------------------------------------------------------- money


def _per_mw_amount(pages: list[PageText], words: str) -> list[Hit]:
    hits = []
    pattern = (
        rf"(?:{words})[^.;]{{0,160}}?{INR}\s*\[?\s*{NUM}\s*\]?\s*(lakhs?|lacs?|crores?|cr)?\s*(?:/-)?\s*"
        r"(?:\([^()]{0,60}?\bper\s+MW(?![hp])[^()]{0,10}\)|(?:\([^()]{0,60}\)\s*)?(?:/|per)\s*MW(?![hp]))"
    )
    for page, m in _iter(pages, pattern):
        amount = number(m.group(1))
        scale = (m.group(2) or "").lower()
        factor = 1e7 if scale.startswith(("crore", "cr")) else 1e5 if scale.startswith(("lakh", "lac")) else 1
        value = amount * factor
        value = int(value) if float(value).is_integer() else value
        note = ""
        if factor != 1:
            prefix = m.group(0)[: m.start(1) - m.start()]
            symbol = [found.start() for found in re.finditer(INR, prefix)]
            printed = collapse(m.group(0)[symbol[-1] if symbol else m.start(1) - m.start() :])
            note = f"The page prints {printed}; written in rupees."
        hits.append(Hit(value, page.page_no, m.start(1), m.end(), note=note))
    return hits


def _emd(pages: list[PageText]) -> list[Hit]:
    return _per_mw_amount(pages, r"\bEMD\b|Earnest\s+Money(?:\s+Deposit)?|Bid\s+Security")


def _pbg(pages: list[PageText]) -> list[Hit]:
    return _per_mw_amount(pages, r"\bPBG\b|Performance\s+(?:Bank\s+)?(?:Guarantee|Security)")


# ----------------------------------------------------------------------------- capacity


def _total_mw(pages: list[PageText]) -> list[Hit]:
    patterns = [
        rf"(?:aggregate|total|cumulative)\s+(?:contracted\s+)?capacity\s+(?:of\s+|is\s+|shall\s+be\s+)?(?:up\s*to\s+)?{NUM}\s*MW(?!h)",
        rf"(?:up\s*to\s+(?:a\s+)?(?:capacity|quantum)\s+of|procurement\s+of|supply\s+of(?:\s+contracted\s+capacity\s+of)?|setting\s+up(?:\s+of)?)\s+{NUM}\s*MW(?!h)",
    ]
    hits = []
    for pattern in patterns:
        for page, m in _iter(pages, pattern):
            # Per-bidder limits and worked examples print other capacities.
            if _example(page, m) or _in_sentence(
                page, m, r"\bminimum\b|\bmaximum\b|not\s+exceed|more\s+than|\bbidder\b|\bwe\b|each\s+project"
            ):
                continue
            hits.append(Hit(number(m.group(1)), page.page_no, m.start(), m.end()))
    hits.sort(key=lambda h: (h.page, h.start))
    return hits


def _mw_mwh_pairs(pages: list[PageText]) -> list[tuple[PageText, re.Match[str]]]:
    pattern = rf"{NUM}\s*MW\s*(?:/|\(|and|&|with)\s*{NUM}\s*MWh"
    return list(_iter(pages, pattern))


def _total_mwh(pages: list[PageText]) -> list[Hit]:
    hits = [Hit(number(m.group(2)), page.page_no, m.start(), m.end()) for page, m in _mw_mwh_pairs(pages)]
    for page, m in _iter(pages, rf"(?:aggregate|total|cumulative)\s+(?:energy\s+|storage\s+)?capacity\s+(?:of\s+)?{NUM}\s*MWh"):
        hits.append(Hit(number(m.group(1)), page.page_no, m.start(), m.end()))
    hits.sort(key=lambda h: (h.page, h.start))
    return hits


def _min_bid(pages: list[PageText]) -> list[Hit]:
    pattern = rf"minimum\s+(?:bid\s+)?(?:capacity|quantum|project\s+size|contracted\s+capacity|bid\s+size)[^.;]{{0,60}}?(?:shall\s+be|will\s+be|is|of)\s+{NUM}\s*MW(?!h)"
    return [
        Hit(number(m.group(1)), page.page_no, m.start(), m.end())
        for page, m in _iter(pages, pattern)
        if not re.search(r"acceptance|part\(s\)|part\s+capacity|commissioning|commencement", m.group(0), re.I)
        and not _example(page, m)
    ]


def _max_bid(pages: list[PageText]) -> list[Hit]:
    patterns = [
        rf"maximum\s+(?:bid\s+)?(?:capacity|quantum|bid\s+size)[^.;]{{0,80}}?(?:shall\s+be|will\s+be|is|of)\s+{NUM}\s*MW(?!h)",
        rf"cumulative\s+capacity\s+(?:offered|quoted)\s+(?:should|shall)?\s*not\s+(?:exceed|exceeding)\s+{NUM}\s*MW(?!h)",
        rf"cumulative\s+capacity\s+(?:offered|quoted)\s+not\s+exceeding\s+{NUM}\s*MW(?!h)",
    ]
    hits = []
    for pattern in patterns:
        hits += [Hit(number(m.group(1)), page.page_no, m.start(), m.end()) for page, m in _iter(pages, pattern)]
    hits.sort(key=lambda h: (h.page, h.start))
    return hits


# ----------------------------------------------------------------------------- location


def _location(pages: list[PageText]) -> tuple[list[Hit], list[Hit]]:
    """(location_constraint hits, named_states_or_sites hits)."""
    anywhere = [Hit("ists_anywhere", page.page_no, m.start(), m.end()) for page, m in _iter(pages, r"anywhere\s+in\s+India")]
    if anywhere:
        return anywhere, []
    sites: list[Hit] = []
    constraint: list[Hit] = []
    site_pattern = (
        r"(?:at|near)\s+(?:the\s+)?(?:\d{2,3}\s*(?:/\s*\d{2,3}\s*)?kV\s+)?"
        r"([A-Z][A-Za-z\-.]+(?:\s+[A-Z][A-Za-z\-.]+){0,3}\s+(?:\d{2,3}\s*/\s*\d{2,3}\s*kV\s+)?"
        r"(?:[Ss]ub-?\s?[Ss]tation|S/S|GSS|Pooling\s+(?:[Ss]ub-?)?[Ss]tation))"
    )
    for page, m in _iter(pages, site_pattern, 0, FRONT_PAGES):
        name = collapse(m.group(1))
        if name.split()[0].lower() in _GENERIC_SITES:
            continue
        constraint.append(Hit("named_substation", page.page_no, m.start(), m.end()))
        sites.append(Hit(name, page.page_no, m.start(1), m.end(1)))
    state_pattern = rf"(?:located|location|situated|sited|set\s+up|setting\s+up|installed|establish\w*)[^.;]{{0,140}}?\b(?:in|within|at)\s+(?:the\s+)?(?:State\s+of\s+)?{STATE}\b"
    for page, m in _iter(pages, state_pattern, re.I, FRONT_PAGES):
        if re.search(r"north[\s-]*east", m.group(0), re.I):
            continue
        state = collapse(m.group(1)).title().replace(" And ", " and ")
        if not constraint:
            constraint.append(Hit("state_specific", page.page_no, m.start(), m.end()))
        sites.append(Hit(state, page.page_no, m.start(1), m.end(1)))
    return constraint, sites


# ----------------------------------------------------------------------------- dates of supply


def _ppa_tenure(pages: list[PageText]) -> list[Hit]:
    pattern = (
        rf"(?:PPA|Power\s+Purchase\s+Agreement|BESPA|BESSPA|ESPA|ESA|PSA|Agreement)[^.;]{{0,140}}?"
        rf"(?:for\s+a\s+(?:period|term)\s+of|(?:period|term|tenure|duration)\s+of|for)\s+{NUMW}{PAREN}\s*years\b"
        rf"|(?:power|supply)\s+for\s+a\s+period\s+of\s+{NUMW}{PAREN}\s*years\b"
    )
    hits = []
    for page, m in _iter(pages, pattern):
        group = 1 if m.group(1) else 2
        value = number(m.group(group))
        if not 5 <= value <= 50 or re.search(r"lock[\s-]*in|extension|beyond", m.group(0), re.I):
            continue
        hits.append(Hit(value, page.page_no, m.start(group), m.end()))
    return hits


_REFERENCES = (
    (r"effective\s+date", "effective_date"),
    (r"(?:signing|execution)\s+of\s+(?:the\s+)?(?:PPA|BESPA|BESSPA|ESPA|agreement|power\s+purchase\s+agreement)", "ppa_signing"),
    (r"(?:issue\s+of\s+)?(?:the\s+)?(?:LoA|Letter\s+of\s+Award)", "loa"),
)


def _scod(pages: list[PageText]) -> tuple[list[Hit], list[Hit]]:
    pattern = (
        r"(?:\bSCOD\b|\bSCSD\b|\bSCD\b|Scheduled\s+(?:Commercial\s+Operation|Commissioning|Commencement[\s-]+of[\s-]+Supply)\s+Date)"
        rf"[^.;]{{0,90}}?(?:shall\s+be|will\s+be|is|within|be)\s+(?:the\s+date\s+as\s+on\s+)?{NUMW}{PAREN}\s*months\s+from\s+(?:the\s+)?(?:date\s+of\s+)?"
        r"(effective\s+date|(?:signing|execution)\s+of\s+(?:the\s+)?(?:PPA|BESPA|BESSPA|ESPA|agreement|power\s+purchase\s+agreement)|(?:issue\s+of\s+)?(?:the\s+)?(?:LoA|Letter\s+of\s+Award))"
    )
    months, references = [], []
    for page, m in _iter(pages, pattern):
        reference = next(name for rx, name in _REFERENCES if re.match(rx, m.group(2), re.I))
        months.append(Hit(number(m.group(1)), page.page_no, m.start(), m.end()))
        references.append(Hit(reference, page.page_no, m.start(), m.end()))
    return months, references


def _ceiling_tariff(pages: list[PageText]) -> list[Hit]:
    patterns = [
        rf"ceiling\s+tariff[^.;]{{0,80}}?{INR}\s*{NUM}\s*(?:/-)?\s*(?:/|per)\s*kWh",
        rf"{INR}\s*{NUM}\s*(?:/-)?\s*(?:/|per)\s*kWh[^.;]{{0,40}}?ceiling",
    ]
    hits = []
    for pattern in patterns:
        hits += [Hit(number(m.group(1)), page.page_no, m.start(), m.end()) for page, m in _iter(pages, pattern)]
    return hits


# ----------------------------------------------------------------------------- FDRE


_PEAK_CUF = rf"minimum\s+(?:of\s+)?{NUM}\s*%\s*CUF\s+(?:during|in)\s+(?:the\s+)?peak\s+hours"


def _availability(pages: list[PageText]) -> list[Hit]:
    patterns = [
        rf"availability\s+(?:of\s+)?(?:minimum\s+|at\s+least\s+)?{NUM}\s*%",
        rf"availability[^.%;]{{0,60}}?(?:less\s+than|at\s+least|minimum\s+of|not\s+below|below)\s+{NUM}\s*%",
        rf"{NUM}\s*%\s+availability",
        rf"demand\s+fulfil+ment\s+ratio[^.%;]{{0,80}}?{NUM}\s*%",
        _PEAK_CUF,
    ]
    hits = []
    for pattern in patterns:
        for page, m in _iter(pages, pattern):
            if not _in_sentence(page, m, r"peak|demand\s+fulfil") or _example(page, m):
                continue
            note = "Stated as the CUF to be supplied during peak hours." if pattern is _PEAK_CUF else ""
            hits.append(Hit(number(m.group(1)), page.page_no, m.start(), m.end(), note=note))
    hits.sort(key=lambda h: (h.page, h.start))
    unique: dict[tuple[int, int], Hit] = {}
    for hit in hits:
        unique.setdefault((hit.page, sentence_bounds(_page(pages, hit.page).text, hit.start, hit.end)[0]), hit)
    return list(unique.values())


def _page(pages: list[PageText], number_: int) -> PageText:
    """The page with this number (pages are numbered from 1, in order)."""
    if 0 < number_ <= len(pages) and pages[number_ - 1].page_no == number_:
        return pages[number_ - 1]
    return next(page for page in pages if page.page_no == number_)


def _peak_hours(pages: list[PageText]) -> list[Hit]:
    patterns = [
        rf"peak\s+hours?\s+(?:will|shall)\s+be\s+{NUMW}{PAREN}\s*hours",
        rf"{NUMW}{PAREN}\s*hours?\s+of\s+(?:assured\s+)?peak",
        rf"peak\s+hours?\s*\(\s*(?:discharging\s+)?{NUMW}{PAREN}\s*hours?\s+(?:daily|a\s+day|per\s+day)",
    ]
    hits = []
    for pattern in patterns:
        hits += [Hit(number(m.group(1)), page.page_no, m.start(), m.end()) for page, m in _iter(pages, pattern)]
    hits.sort(key=lambda h: (h.page, h.start))
    return hits


_WINDOW = rf"{NUMW}{PAREN}\s*hours?\b[^.;]{{0,60}}?(\d{{1,2}}[:.]\d{{2}})\s*(?:hrs?\.?|hours)?\s*(?:to|-|–)\s*(\d{{1,2}}[:.]\d{{2}})"


def _peak_blocks(pages: list[PageText]) -> list[tuple[int, int, int, list[dict[str, Any]]]]:
    """(page, start, end, blocks) for each sentence that defines peak windows by clock time."""
    found = []
    seen: set[tuple[int, int]] = set()
    for page, m in _iter(pages, _WINDOW):
        start, end = sentence_bounds(page.text, m.start(), m.end())
        if (page.page_no, start) in seen or not re.search(r"peak", page.text[start:end], re.I):
            continue
        seen.add((page.page_no, start))
        blocks = []
        last_end = start
        for w in re.finditer(_WINDOW, page.text[start:end], re.I):
            blocks.append({"window_start": w.group(2).replace(".", ":"), "window_end": w.group(3).replace(".", ":"), "hours": number(w.group(1))})
            last_end = start + w.end()
        if blocks:
            found.append((page.page_no, start, last_end, blocks))
    return found


def _storage_mandatory(pages: list[PageText]) -> list[Hit]:
    positive = [
        r"(?:energy\s+storage\s+systems?|\bESS\b|\bBESS\b)\s*(?:\(ESS\)\s*)?(?:shall|will|must)\s+(?:mandatorily|compulsorily)",
        r"(?:energy\s+storage\s+systems?|\bESS\b|storage)[^.;]{0,40}?(?:is|are|shall\s+be)\s+mandatory",
        r"mandated\s+to\s+install\s+(?:ESS|energy\s+storage|BESS|storage)",
    ]
    negative = [
        r"(?:energy\s+storage|\bESS\b|storage)[^.;]{0,60}?(?:is|are|shall\s+be)\s+(?:optional|not\s+mandatory)",
        r"(?:if|where|in\s+case)\s+the\s+(?:developer|bidder|supplier|seller|generator)\s+(?:elects|chooses|opts|decides)\s+to[^.;]{0,60}?(?:storage|\bBESS\b|\bESS\b)",
    ]
    hits = []
    for pattern in positive:
        hits += [Hit(True, page.page_no, m.start(), m.end()) for page, m in _iter(pages, pattern)]
    for pattern in negative:
        hits += [Hit(False, page.page_no, m.start(), m.end()) for page, m in _iter(pages, pattern)]
    hits.sort(key=lambda h: (h.page, h.start))
    return hits


_MULTIPLE_TARIFF = rf"{MULT}\s+times\s+(?:of\s+)?(?:the\s+)?(?:applicable\s+|PPA\s+|quoted\s+|contracted\s+)*tariff"


def _shortfall_multiple(pages: list[PageText]) -> list[Hit]:
    pattern = rf"(?:penalty|compensation|damages)[^.;]{{0,200}}?\b{_MULTIPLE_TARIFF}"
    hits = []
    for page, m in _iter(pages, pattern):
        if not _in_sentence(page, m, r"shortfall|not\s+meeting|not\s+supplied|short\s+supply|availability"):
            continue
        hits.append(Hit(number(m.group(1)), page.page_no, m.start(1), m.end()))
    return hits


def _shortfall_threshold(pages: list[PageText]) -> list[tuple[PageText, re.Match[str], float]]:
    patterns = [
        rf"shortfall\s+in\s+(?:the\s+)?{NUM}\s*%\s+(?:peak\s+)?availability",
        rf"shortfall\s+in\s+(?:the\s+)?(?:peak\s+|monthly\s+|annual\s+)?availability[^.;%]{{0,40}}?(?:below|of|less\s+than)\s+{NUM}\s*%",
    ]
    found = []
    for pattern in patterns:
        found += [(page, m, number(m.group(1))) for page, m in _iter(pages, pattern)]
    found.sort(key=lambda item: (item[0].page_no, item[1].start()))
    return found


def _shortfall_rule(pages: list[PageText], page_text: dict[int, str]) -> RuleDraft | None:
    """One shortfall rule: its threshold and the multiple of the tariff charged."""
    thresholds = _shortfall_threshold(pages)
    multiple_rx = re.compile(rf"{MULT}\s+times\s+(?:of\s+)?(?:the\s+)?(?:\w+\s+){{0,2}}(?:tariff|capacity\s+charges?)", re.I)
    for page, m, threshold in thresholds:
        start, end = sentence_bounds(page.text, m.start(), m.end())
        sentence = page.text[start:end]
        multiple = None
        for offset in range(0, 3):
            if page.page_no + offset > len(pages):
                break
            other = _page(pages, page.page_no + offset)
            from_index = m.end() if offset == 0 else 0
            mm = multiple_rx.search(other.text, from_index)
            if mm and (offset > 0 or mm.start() - m.end() < 2500):
                multiple = (other, mm)
                break
        if multiple is None:
            continue
        other, mm = multiple
        metric = (
            "peak_availability"
            if re.search(r"peak", sentence, re.I)
            else "annual_cuf"
            if re.search(r"\bCUF\b", sentence)
            else "monthly_availability"
        )
        measured = "monthly" if re.search(r"month", sentence, re.I) else "annual" if re.search(r"annual|year", sentence, re.I) else None
        lines = [
            f"metric: {metric}",
            f"threshold_pct: {threshold:g}",
            *([f"measured: {measured}"] if measured else []),
            f"penalty_multiple_of_tariff: {number(mm.group(1)):g}",
        ]
        quotes = [(page.page_no, make_quote(page.text, m.start(), m.end()))]
        second = make_quote(other.text, mm.start(), mm.end())
        if (other.page_no, second) not in quotes:
            quotes.append((other.page_no, second))
        rationale = (
            f"Read by the rules reader: the threshold from page {page.page_no}, the multiple of the "
            f"tariff from page {other.page_no}."
        )
        return RuleDraft([" | ".join(lines)], CONFIDENCE, rationale, quotes)
    return None


def _cuf_min(pages: list[PageText]) -> list[Hit]:
    patterns = [
        rf"\bCUF\s+(?:shall|will|should)\s+(?:in\s+no\s+case\s+be\s+less\s+than|not\s+be\s+(?:below|less\s+than))\s+{NUM}\s*%",
        rf"minimum\s+(?:declared\s+)?(?:annual\s+)?CUF\s+(?:of\s+)?{NUM}\s*%",
    ]
    hits = []
    for pattern in patterns:
        hits += [Hit(number(m.group(1)), page.page_no, m.start(), m.end()) for page, m in _iter(pages, pattern)]
    hits.sort(key=lambda h: (h.page, h.start))
    return hits


def _cuf_band(pages: list[PageText]) -> list[Hit]:
    pattern = rf"\bCUF\s+within\s+\(?\s*\+\s*\)?\s*{NUM}\s*%\s+and\s+\(?\s*[-–−]\s*\)?\s*{NUM}\s*%"
    return [
        Hit((100 + number(m.group(1)), 100 - number(m.group(2))), page.page_no, m.start(), m.end())
        for page, m in _iter(pages, pattern)
    ]


_SOURCE_TRIGGERS = (
    r"generating\s+system\(?s?\)?\s+(?:including|comprising|such\s+as|based\s+on)\s+(?:solar|wind|hydro)"
    r"|renewable\s+(?:energy\s+)?(?:resources?|sources?)\s+(?:including|such\s+as|like|viz\.?)\s+(?:solar|wind|hydro)"
    r"|power\s+from\s+(?:solar|wind)\s+power\s+generating"
    r"|(?:from|of)\s+(?:RE|renewable(?:\s+energy)?)\s+(?:projects?|sources?|plants?|generators?)\s*\(\s*(?:solar|wind|hydro)"
)
_SOURCES = (
    (r"\bsolar\b", "Solar"),
    (r"\bwind\b", "Wind"),
    (r"\b(?:small\s+)?hydro(?!gen)\b", "Hydro"),
    (r"\bbio[\s-]?mass\b|\bbio[\s-]?energy\b", "Biomass"),
    (r"any\s+other\s+renewable", "Any other renewable resource"),
    (r"energy\s+storage|\bstorage\b|\bESS\b|\bBESS\b|\bPSP\b|\bbattery\b|pumped\s+storage", "Energy storage"),
)


def _sources(pages: list[PageText]) -> list[Hit]:
    hits = []
    seen: set[tuple[int, int]] = set()
    for page, m in _iter(pages, _SOURCE_TRIGGERS):
        start, end = sentence_bounds(page.text, m.start(), m.end())
        if (page.page_no, start) in seen:
            continue
        seen.add((page.page_no, start))
        quote = make_quote(page.text, m.start(), m.end())
        named = []
        for pattern, name in _SOURCES:
            found = re.search(pattern, quote, re.I)
            if found:
                named.append((found.start(), name))
        sources = [name for _, name in sorted(named)]
        if len(sources) >= 2:
            hit = Hit(sources, page.page_no, m.start(), m.end(), key=frozenset(sources))
            hit.quote = quote
            hits.append(hit)
    return hits


def _sources_draft(hits: list[Hit]) -> RuleDraft | None:
    """Every source the passages name, in the order they first appear, with the quotes
    that name them (at most three)."""
    sources: list[str] = []
    quotes: list[tuple[int, str]] = []
    for hit in hits:
        new = [name for name in hit.value if name not in sources]
        if not new or len(quotes) >= 3:
            continue
        sources += new
        quotes.append((hit.page, hit.quote))
    if not sources:
        return None
    pages_ = sorted({page for page, _ in quotes})
    rationale = (
        f"Read by the rules reader from page{'s' if len(pages_) > 1 else ''} {', '.join(str(p) for p in pages_)}: "
        "the sources the passages name as allowed for the supply."
    )
    return RuleDraft(sources, CONFIDENCE, rationale, quotes)


def _biomass(pages: list[PageText], source_hits: list[Hit]) -> list[Hit]:
    hits = []
    for page, m in _iter(pages, r"bio[\s-]?mass|bio[\s-]?energy"):
        if _in_sentence(page, m, r"not\s+(?:be\s+)?(?:permitted|allowed|eligible)|excluded|shall\s+not"):
            hits.append(Hit(False, page.page_no, m.start(), m.end()))
    for hit in source_hits:
        if "Biomass" in hit.value:
            positive = Hit(True, hit.page, hit.start, hit.end)
            positive.quote = hit.quote
            hits.append(positive)
    return hits


# ----------------------------------------------------------------------------- supply floors (FDRE overlay)

DATE2 = (
    r"(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}"
    r"|\d{1,2}(?:st|nd|rd|th)?[\s\-.,]+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?[\s\-.,]+\d{2,4})"
)


def _percent_hits(pages: list[PageText], patterns: list[str], context: str | None = None) -> list[Hit]:
    hits = []
    for pattern in patterns:
        for page, m in _iter(pages, pattern):
            if (context and not _in_sentence(page, m, context)) or _example(page, m):
                continue
            hits.append(Hit(number(m.group(1)), page.page_no, m.start(), m.end()))
    hits.sort(key=lambda h: (h.page, h.start))
    return hits


def _annual_supply(pages: list[PageText]) -> list[Hit]:
    return _percent_hits(
        pages,
        [
            rf"minimum\s+(?:of\s+)?{NUM}\s*%\s*CUF\s+(?:for|in)\s+(?:each|every|an?)\s+(?:accounting\s+|contract\s+|financial\s+)?year",
            rf"\bannual\s+CUF\s+(?:shall|will|should)\s+(?:in\s+no\s+case\s+be\s+less\s+than|not\s+be\s+(?:below|less\s+than))\s+{NUM}\s*%",
            rf"\bannual\s+(?:availability|CUF)\s+of\s+(?:minimum\s+|at\s+least\s+|not\s+less\s+than\s+)?{NUM}\s*%",
        ],
    )


def _monthly_supply(pages: list[PageText]) -> list[Hit]:
    return _percent_hits(
        pages,
        [
            rf"minimum\s+(?:of\s+)?{NUM}\s*%\s*CUF\s+on\s+(?:a\s+)?monthly\s+basis",
            rf"\bmonthly\s+(?:CUF|availability|supply)\s+(?:of\s+)?(?:minimum\s+|at\s+least\s+|not\s+less\s+than\s+)?{NUM}\s*%",
        ],
    )


def _green_share(pages: list[PageText]) -> list[Hit]:
    return _percent_hits(
        pages,
        [
            rf"minimum\s+(?:of\s+)?{NUM}\s*%\s+shall\s+be\s+(?:traceable\s+)?green",
            rf"{NUM}\s*%\s+(?:of\s+(?:the\s+)?(?:supply|energy|power)\s+)?(?:shall\s+be\s+)?traceable\s+green",
            rf"minimum\s+(?:of\s+)?{NUM}\s*%\s+(?:of\s+(?:the\s+)?(?:supply|energy|power)\s+)?(?:shall\s+be\s+)?(?:from\s+)?(?:RE|renewable)\s+(?:sources?|power|energy)",
        ],
    )


def _non_re(pages: list[PageText]) -> list[Hit]:
    hits = []
    for page, m in _iter(pages, r"non[\s-]*RE\b|non[\s-]*renewable"):
        start, end = sentence_bounds(page.text, m.start(), m.end())
        sentence = page.text[start:end]
        if re.search(r"non[\s-]*(?:RE|renewable)[^.;]{0,60}?(?:not\s+(?:be\s+)?(?:permitted|allowed)|shall\s+not)", sentence, re.I):
            hits.append(Hit(False, page.page_no, m.start(), m.end()))
        elif re.search(r"\b(?:can|may|allowed|permitted|balance)\b", sentence, re.I) and not re.search(
            r"would\s+not\s+qualify|not\s+qualify", sentence, re.I
        ):
            hits.append(Hit(True, page.page_no, m.start(), m.end()))
    return hits


def _solar_multiple(pages: list[PageText]) -> list[Hit]:
    pattern = (
        r"solar\s+(?:power\s+)?capacity\s+(?:equivalent|equal)\s+to\s+"
        rf"(twice|thrice|double|{NUMW}\s+times)\s+(?:of\s+)?(?:the\s+)?contracted"
    )
    hits = []
    for page, m in _iter(pages, pattern):
        raw = m.group(1).lower()
        value = {"twice": 2, "double": 2, "thrice": 3}.get(raw)
        if value is None:
            value = number(m.group(2))
        # quote the whole requirement: the GW it means and where the solar may be built
        tail = re.search(r"^[^;]{0,300}?anywhere\s+in\s+India", page.text[m.end() :], re.I)
        hits.append(Hit(value, page.page_no, m.start(), m.end() + (tail.end() if tail else 0), mode="span" if tail else "sentence"))
    return hits


_SELLER = r"\b(?:RPD|RE[\s-]*PG|SPD|developer|supplier|selected\s+bidder|bidder|(?:RE\s+)?power\s+generator)\b"
_NOT_SALE = (
    r"transferred|\bright\s+to\s+(?:regulate|divert)|\bhave\s+(?:a|the|full)\s+right|discom|compensation|debarred"
    r"|breach|penalty|priority|offered\s+to\s+the\s+procurer[^.]{0,40}not\s+(?:accept|give)"
)


def _market_sale(pages: list[PageText]) -> list[Hit]:
    """What the supplier may schedule or sell in the market during the contract: a sentence
    in which the supplier (bidder, developer, RPD/RE-PG) sells or schedules power in the market,
    a power exchange or to a third party. Energy before the supply start date, the procurer's
    own rights, compensation and penalty clauses are other matters and are skipped."""
    hits = []
    pattern = r"in\s+the\s+(?:open\s+)?market|power\s+exchanges?|\bIEX\b|third[\s-]+part(?:y|ies)"
    for page, m in _iter(pages, pattern):
        start, end = sentence_bounds(page.text, m.start(), m.end())
        sentence = page.text[start:end]
        if not re.search(r"\b(?:schedul\w*|sell\w*|sale)\b", sentence, re.I):
            continue
        if not re.search(r"\b(?:power|energy|electricity|capacity)\b", sentence, re.I) or not re.search(_SELLER, sentence, re.I):
            continue
        if re.search(_NOT_SALE, sentence, re.I):
            continue
        if re.search(r"(?:until|till|prior\s+to|before)\s+(?:the\s+)?(?:SSD|SCSD|SCOD|supply\s+start|scheduled\s+commencement)|\bearly\b", sentence, re.I):
            continue
        if re.search(r"shall\s+not|not\s+(?:be\s+)?(?:allowed|permitted)|prohibited", sentence, re.I):
            value = "not_allowed"
        elif re.search(r"solar\s+power\s+capacity|solar\s+capacity", sentence, re.I):
            value = "mandated_solar"
        else:
            value = "any_capacity"
        hits.append(Hit(value, page.page_no, m.start(), m.end()))
    return hits


def _ppa_priority(pages: list[PageText]) -> list[Hit]:
    """The PPA comes before any sale elsewhere: an explicit priority clause, or a penalty or
    breach for selling while the PPA demand is unmet."""
    patterns = [
        r"priority\s+shall\s+be\s+(?:accorded|given)?\s*(?:for|to)?\s*(?:meet(?:ing)?|meet)\s+the\s+(?:energy|capacity)\s+requirements?\s+as\s+per\s+(?:the\s+)?PPA[^.]{0,40}before\s+selling",
        r"while\s+the\s+demand\s+specified\s+in\s+the\s+PPA\s+remains\s+unfulfilled",
    ]
    hits = []
    for pattern in patterns:
        hits += [Hit(True, page.page_no, m.start(), m.end()) for page, m in _iter(pages, pattern)]
    hits.sort(key=lambda h: (h.page, h.start))
    return hits


def _peak_set_by(pages: list[PageText]) -> list[Hit]:
    """Who fixes the peak hours, from the sentence that defines them."""
    hits = []
    for page, m in _iter(pages, r"peak\s+hours?"):
        start, end = sentence_bounds(page.text, m.start(), m.end())
        sentence = page.text[start:end]
        if re.search(r"(?:as|to\s+be)\s+(?:decided|declared|notified|specified|intimated)\s+by\s+(?:the\s+)?(?:procurer|buying\s+entity|WBSEDCL|NHPC|SECI|NTPC|SJVN|discom|end\s+procurer|\w+\s+procurer)", sentence, re.I):
            hits.append(Hit("procurer", page.page_no, m.start(), m.end()))
        elif re.search(r"(?:as|to\s+be)\s+(?:decided|chosen|declared)\s+by\s+the\s+(?:supplier|developer|bidder|RPD|RE[\s-]*PG)", sentence, re.I):
            hits.append(Hit("supplier", page.page_no, m.start(), m.end()))
    return hits


def _greenshoe(pages: list[PageText]) -> list[Hit]:
    patterns = [
        rf"{NUM}\s*MW\s*\(?\s*green\s*-?\s*shoe",
        rf"green\s*-?\s*shoe\s+(?:supply\s+)?capacity\s+(?:of\s+)?{NUM}\s*MW",
    ]
    hits = []
    for pattern in patterns:
        hits += [Hit(number(m.group(1)), page.page_no, m.start(), m.end()) for page, m in _iter(pages, pattern)]
    hits.sort(key=lambda h: (h.page, h.start))
    return hits


def _part_capacity(pages: list[PageText]) -> list[Hit]:
    """No part capacity: a single bidder must bid for the whole capacity."""
    return [Hit(False, page.page_no, m.start(), m.end()) for page, m in _iter(pages, r"no\s+part\s+capacity")]


def _greenshoe_start(pages: list[PageText]) -> list[Hit]:
    """The greenshoe capacity's supply start date, printed in the sentence on the greenshoe."""
    hits = []
    pattern = rf"green\s*-?\s*shoe[^;]{{0,250}}?supply\s+start\s+date\s+(?:of|shall\s+be|:)\s*{DATE2}"
    for page, m in _iter(pages, pattern):
        try:
            value, note = _iso_date(m.group(1))
        except ValueError:
            continue
        hits.append(Hit(value, page.page_no, m.start(1), m.end(1), note=note))
    return hits


def _greenshoe_same_tariff(pages: list[PageText]) -> list[Hit]:
    """The greenshoe capacity is supplied at the same terms and tariff as the base capacity."""
    pattern = r"green\s*-?\s*shoe[^;]{0,400}?(?:same\s+terms\s+and\s+conditions\s+and\s+(?:the\s+)?applicable\s+tariff|uniform\s+tariff)"
    return [Hit(True, page.page_no, m.end() - 30, m.end()) for page, m in _iter(pages, pattern)]


def _iso_date(raw: str) -> tuple[str, str]:
    """(YYYY-MM-DD, note) for a printed date; a two-digit year is read as 20YY."""
    from tender_intel.values import _date

    text = collapse(raw)
    two_digit = re.match(r"^(.*?[\s\-./,])(\d{2})$", text)
    if two_digit and not re.search(r"\d{4}$", text):
        expanded = f"{two_digit.group(1)}20{two_digit.group(2)}"
        return _date(expanded, None), f"The page prints {text}; the year is read as 20{two_digit.group(2)}."
    return _date(text, None), ""


def _supply_start(pages: list[PageText]) -> list[Hit]:
    pattern = (
        r"(?:\bSSD\b|\bSCSD\b|supply\s+start\s+date|scheduled\s+commencement\s+(?:date\s+)?of\s+supply(?:\s+date)?)"
        rf"[^.;\n]{{0,40}}?(?:shall\s+be|will\s+be|is|of|:)\s*{DATE2}"
    )
    hits = []
    for page, m in _iter(pages, pattern):
        line_start = page.text.rfind("\n", 0, m.start()) + 1
        start, end = sentence_bounds(page.text, m.start(), m.end())
        context = page.text[min(line_start, start) : m.end()]
        previous = _page(pages, page.page_no - 1) if page.page_no > 1 else None
        if re.search(r"green\s*-?\s*shoe|phase\s*(?:2|ii)\b", context, re.I) or _example(page, m, 300, previous):
            continue
        try:
            value, note = _iso_date(m.group(1))
        except ValueError:
            continue
        hits.append(Hit(value, page.page_no, m.start(), m.end(), note=note))
    return hits


# ----------------------------------------------------------------------------- BESS


def _bess_capacity(pages: list[PageText]) -> tuple[list[Hit], list[Hit]]:
    pairs = _mw_mwh_pairs(pages)
    power = [Hit(number(m.group(1)), page.page_no, m.start(), m.end()) for page, m in pairs]
    energy = [Hit(number(m.group(2)), page.page_no, m.start(), m.end()) for page, m in pairs]
    return power, energy


def _cycles(pages: list[PageText]) -> list[Hit]:
    patterns = [
        rf"{BESS.WORD_NUM}\s*(?:\(\s*[\w\s-]{{1,20}}\)\s*)?(?:full\s+|complete\s+|operational\s+)?(?:charge[- /]discharge\s+|charging[- /]discharging\s+)?cycles?\s*(?:per|a|in\s+a|each)\s*day",
        rf"cycles?\s*per\s*day\s*(?:shall\s+be|of|is|:|=)\s*{BESS.WORD_NUM}",
    ]
    hits = []
    for pattern in patterns:
        hits += [Hit(BESS._num(m.group(1)), page.page_no, m.start(), m.end()) for page, m in _iter(pages, pattern)]
    return [Hit(int(h.value) if float(h.value).is_integer() else h.value, h.page, h.start, h.end) for h in hits]


def _rte(pages: list[PageText]) -> list[Hit]:
    patterns = [
        rf"round[- ]?trip\s+efficiency[^%]{{0,160}}?(?:not\s+(?:be\s+)?less\s+than|at\s+least|minimum(?:\s+of)?|≥|>=|of)\s*{NUM}\s*%",
        rf"(?:\bRTE\b|AC[- ]AC\s+efficiency)[^%]{{0,120}}?(?:not\s+(?:be\s+)?less\s+than|at\s+least|minimum(?:\s+of)?|≥|>=|of)\s*{NUM}\s*%",
    ]
    hits = []
    for pattern in patterns:
        hits += [Hit(number(m.group(1)), page.page_no, m.start(), m.end()) for page, m in _iter(pages, pattern)]
    return hits


def _bess_availability(pages: list[PageText]) -> list[Hit]:
    patterns = [
        rf"(?:system\s+|annual\s+|monthly\s+|guaranteed\s+)?availability[^%;]{{0,160}}?(?:not\s+(?:be\s+)?less\s+than|at\s+least|minimum(?:\s+of)?|≥|>=)\s*{NUM}\s*%",
        rf"{NUM}\s*%\s*(?:system\s+|annual\s+|monthly\s+)?availability",
    ]
    hits = []
    for pattern in patterns:
        hits += [Hit(number(m.group(1)), page.page_no, m.start(), m.end()) for page, m in _iter(pages, pattern)]
    hits.sort(key=lambda h: (h.page, h.start))
    return hits


# ----------------------------------------------------------------------------- reader

# Every field path the rules reader looks for. A field of the type outside this list is
# reported as not read in rules mode.
RULE_PATHS = (
    "core.identity.tender_number",
    "core.identity.issuing_agency",
    "core.identity.title",
    "core.identity.tender_type_as_stated",
    "core.key_dates.bid_submission_deadline",
    "core.key_dates.pre_bid_meeting_date",
    "core.key_dates.nit_date",
    "core.key_dates.query_deadline",
    "core.key_dates.technical_opening_date",
    "core.key_dates.era_date",
    "core.key_dates.query_response_date",
    "core.key_dates.document_sale_end_date",
    "core.key_dates.loa_date",
    "core.key_dates.ppa_execution_date",
    "sector.power.common.greenshoe_offer_date",
    "core.summary.plain_english_summary",
    "core.guarantees.emd_per_mw_inr",
    "core.guarantees.pbg_per_mw_inr",
    "core.penalties.shortfall_rules",
    "sector.power.common.total_capacity_mw",
    "sector.power.common.total_capacity_mwh",
    "sector.power.common.min_bid_mw",
    "sector.power.common.max_bid_mw",
    "sector.power.common.location_constraint",
    "sector.power.common.named_states_or_sites",
    "sector.power.common.ppa_tenure_years",
    "sector.power.common.scod_months",
    "sector.power.common.scod_reference",
    "sector.power.common.tariff_ceiling_inr_per_kwh",
    "sector.power.fdre.assured_availability_percent",
    "sector.power.fdre.demand_profile",
    "sector.power.fdre.peak_window_definition",
    "sector.power.fdre.storage_mandatory",
    "sector.power.fdre.shortfall_compensation_multiple",
    "sector.power.fdre.permitted_re_sources",
    "sector.power.fdre.biomass_permitted",
    "sector.power.fdre.demand_profile_structured",
    "sector.power.fdre.annual_supply_min_pct",
    "sector.power.fdre.monthly_supply_min_pct",
    "sector.power.fdre.peak_supply_min_pct",
    "sector.power.fdre.peak_hours_per_day",
    "sector.power.fdre.green_share_min_pct",
    "sector.power.fdre.non_re_allowed",
    "sector.power.fdre.min_solar_capacity_multiple",
    "sector.power.fdre.market_sale_scope",
    "sector.power.fdre.ppa_priority_before_sale",
    "sector.power.fdre.peak_hours_set_by",
    "sector.power.fdre.supply_start_date",
    "sector.power.common.greenshoe_capacity_mw",
    "sector.power.common.part_capacity_allowed",
    "sector.power.common.greenshoe_supply_start_date",
    "sector.power.common.greenshoe_same_tariff",
    "sector.power.bess.capacity_mw",
    "sector.power.bess.capacity_mwh",
    "sector.power.bess.cycles_per_day",
    "sector.power.bess.round_trip_efficiency_guarantee_percent",
    "sector.power.bess.availability_floor_percent",
)


def _list_draft(hits: list[Hit], page_text: dict[int, str]) -> RuleDraft | None:
    """A list of distinct values, each with its own quote (at most three quotes)."""
    if not hits:
        return None
    values: list[str] = []
    quotes: list[tuple[int, str]] = []
    pages_seen = []
    for hit in hits:
        if hit.value not in values:
            values.append(hit.value)
            quote = (hit.page, _quote_of(page_text, hit))
            if quote not in quotes and len(quotes) < 3:
                quotes.append(quote)
            pages_seen.append(hit.page)
    rationale = f"Read by the rules reader from page{'s' if len(set(pages_seen)) > 1 else ''} {', '.join(str(p) for p in sorted(set(pages_seen)))}."
    return RuleDraft(values, CONFIDENCE, rationale, quotes)


def _demand_structured(
    availability: RuleDraft | None,
    peak_hours: RuleDraft | None,
    blocks: list[tuple[int, int, int, list[dict[str, Any]]]],
    cuf_min: RuleDraft | None,
    cuf_band: RuleDraft | None,
    pages: list[PageText],
    green_share: RuleDraft | None = None,
) -> RuleDraft | None:
    lines: list[str] = []
    quotes: list[tuple[int, str]] = []
    notes = []

    def add_quotes(draft: RuleDraft | None) -> None:
        for quote in draft.quotes if draft else []:
            if quote not in quotes:
                quotes.append(quote)

    if availability is not None:
        lines += ["basis: availability_pct", f"peak_availability_pct: {availability.value:g}"]
        add_quotes(availability)
        notes.append(f"peak availability (p.{availability.quotes[0][0]})")
    if peak_hours is not None:
        lines.append(f"peak_hours_per_day: {peak_hours.value:g}")
        add_quotes(peak_hours)
        notes.append(f"peak hours (p.{peak_hours.quotes[0][0]})")
    if blocks:
        page_no, start, end, items = blocks[0]
        for item in items:
            lines.append(
                f"peak_blocks: window_start={item['window_start']}; window_end={item['window_end']}; hours={item['hours']:g}"
            )
        quote = (page_no, make_quote(_page(pages, page_no).text, start, end))
        if quote not in quotes:
            quotes.append(quote)
        notes.append(f"peak windows (p.{page_no})")
    if cuf_min is not None:
        lines.append(f"cuf_declared_min_pct: {cuf_min.value:g}")
        add_quotes(cuf_min)
        notes.append(f"lowest declared CUF (p.{cuf_min.quotes[0][0]})")
    if cuf_band is not None:
        upper, lower = cuf_band.value
        lines += [f"cuf_band_upper_pct: {upper:g}", f"cuf_band_lower_pct: {lower:g}"]
        add_quotes(cuf_band)
        notes.append(f"CUF band (p.{cuf_band.quotes[0][0]})")
    if green_share is not None:
        lines.append(f"re_share_min_pct: {green_share.value:g}")
        add_quotes(green_share)
        notes.append(f"lowest green share (p.{green_share.quotes[0][0]})")
    if not lines:
        return None
    rationale = "Assembled by the rules reader from " + ", ".join(notes) + "."
    confidence = min(
        [d.confidence for d in (availability, peak_hours, cuf_min, cuf_band, green_share) if d is not None] or [CONFIDENCE]
    )
    return RuleDraft(lines, confidence, rationale, quotes)


def _inr(value: float) -> str:
    """Indian digit grouping: 100000 -> 1,00,000."""
    n = str(int(round(value)))
    if len(n) <= 3:
        return n
    head, tail = n[:-3], n[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    return ",".join(([head] if head else []) + groups + [tail])


def _summary_draft(got: dict[str, RuleDraft | None]) -> RuleDraft | None:
    """A plain-English summary assembled only from the fields read above: each sentence states
    values the rules reader found, and carries their quotes. Nothing else is added."""

    def val(path: str) -> Any:
        draft = got.get(path)
        return draft.value if draft is not None else None

    def date(path: str) -> str | None:
        raw = val(path)
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", _date_key(str(raw)) if raw else "")
        return f"{m[3]}.{m[2]}.{m[1]}" if m else None

    paras: list[str] = []
    quotes: list[tuple[int, str]] = []

    def add(text: str, paths: list[str]) -> None:
        paras.append(text)
        for path in paths:
            draft = got.get(path)
            for quote in draft.quotes if draft is not None else []:
                if quote not in quotes:
                    quotes.append(quote)

    C, F, K = "sector.power.common", "sector.power.fdre", "core.key_dates"
    issuer, total, greenshoe, years = val("core.identity.issuing_agency"), val(f"{C}.total_capacity_mw"), val(f"{C}.greenshoe_capacity_mw"), val(f"{C}.ppa_tenure_years")
    if issuer and total:
        kind = val("core.identity.tender_type_as_stated") or "power"
        text = f"{issuer} procures {total:,.0f} MW of {kind}"
        text += f", with a {greenshoe:,.0f} MW greenshoe at its option" if greenshoe else ""
        text += f", for {years:g} years." if years else "."
        add(text, ["core.identity.issuing_agency", f"{C}.total_capacity_mw", f"{C}.greenshoe_capacity_mw", f"{C}.ppa_tenure_years"])
    green, non_re = val(f"{F}.green_share_min_pct"), val(f"{F}.non_re_allowed")
    if green:
        text = f"At least {green:g}% of the supply must be traceable green power each accounting year"
        text += "; the balance may come from RE or non-RE sources, with RECs for the non-RE supply." if non_re else "."
        add(text, [f"{F}.green_share_min_pct", f"{F}.non_re_allowed"])
    annual, monthly, peak, hours = (val(f"{F}.annual_supply_min_pct"), val(f"{F}.monthly_supply_min_pct"),
                                    val(f"{F}.peak_supply_min_pct"), val(f"{F}.peak_hours_per_day"))
    floors = [f"{annual:g}% CUF each accounting year" if annual else None, f"{monthly:g}% every month" if monthly else None,
              f"{peak:g}% in {hours:g} peak hours a day" if peak and hours else (f"{peak:g}% in peak hours" if peak else None)]
    if any(floors):
        text = "Supply must be at least " + ", ".join(x for x in floors if x)
        text += ", the peak hours as decided by the procurer." if val(f"{F}.peak_hours_set_by") == "procurer" else "."
        add(text, [f"{F}.annual_supply_min_pct", f"{F}.monthly_supply_min_pct", f"{F}.peak_supply_min_pct", f"{F}.peak_hours_per_day", f"{F}.peak_hours_set_by"])
    sources, multiple, place = val(f"{F}.permitted_re_sources"), val(f"{F}.min_solar_capacity_multiple"), val(f"{C}.location_constraint")
    parts = []
    if sources:
        parts.append("Renewable sources named: " + ", ".join(sources) + ".")
    if multiple:
        solar = f"Solar of {multiple:g} × the contracted capacity is mandatory"
        if total:
            solar += f" ({multiple * total:,.0f} MW for the base capacity" + (f", {multiple * greenshoe:,.0f} MW more if the greenshoe is exercised)" if greenshoe else ")")
        solar += ", anywhere in India" if place == "ists_anywhere" else ""
        parts.append(solar + ".")
    if val(f"{F}.market_sale_scope") == "mandated_solar":
        parts.append("That solar may be scheduled to the PPA or in the market.")
    if parts:
        add(" ".join(parts), [f"{F}.permitted_re_sources", f"{F}.min_solar_capacity_multiple", f"{C}.location_constraint", f"{F}.market_sale_scope"])
    if val(f"{C}.part_capacity_allowed") is False:
        add("A single bidder must bid the whole capacity; no part capacity is allowed.", [f"{C}.part_capacity_allowed"])
    ssd, gs_ssd, gs_offer = date(f"{F}.supply_start_date"), date(f"{C}.greenshoe_supply_start_date"), date(f"{C}.greenshoe_offer_date")
    if ssd or gs_ssd:
        text = f"Supply starts on {ssd}" if ssd else "The greenshoe"
        if gs_ssd:
            text += f"; the greenshoe, if exercised, from {gs_ssd}" if ssd else f" supply starts on {gs_ssd}"
            text += " at the same tariff" if val(f"{C}.greenshoe_same_tariff") else ""
            text += f" (offered at least 30 days before {gs_offer})" if gs_offer else ""
        add(text + ".", [f"{F}.supply_start_date", f"{C}.greenshoe_supply_start_date", f"{C}.greenshoe_same_tariff", f"{C}.greenshoe_offer_date"])
    steps = [("Bids close", f"{K}.bid_submission_deadline"), ("techno-commercial opening", f"{K}.technical_opening_date"),
             ("e-reverse auction", f"{K}.era_date"), ("Letter of Award", f"{K}.loa_date"), ("PPA execution", f"{K}.ppa_execution_date")]
    found = [(label, path) for label, path in steps if date(path)]
    if found:
        add("; ".join(f"{label} {date(path)}" for label, path in found) + ".", [path for _, path in found])
    emd, pbg = val("core.guarantees.emd_per_mw_inr"), val("core.guarantees.pbg_per_mw_inr")
    if emd or pbg:
        money = [f"bid security (EMD) ₹{_inr(emd)} per MW" if emd else None, f"performance guarantee ₹{_inr(pbg)} per MW" if pbg else None]
        text = "; ".join(x for x in money if x)
        add(text[0].upper() + text[1:] + ".", ["core.guarantees.emd_per_mw_inr", "core.guarantees.pbg_per_mw_inr"])
    if not paras:
        return None
    return RuleDraft("\n\n".join(paras), CONFIDENCE, "Assembled by the rules reader from the fields it read, each quoted on its page; nothing else is added.", quotes)


def read(pages: list[PageText], paths: Iterable[str]) -> dict[str, RuleDraft | None]:
    """A draft (or None when nothing was found) for each wanted path the rules reader
    covers. Paths it does not cover are left out of the result."""
    wanted = set(paths) & set(RULE_PATHS)
    text_pages = list(pages)  # every page, so that pages[n - 1] is page n
    page_text = {page.page_no: page.text for page in pages}
    out: dict[str, RuleDraft | None] = {}

    def put(path: str, draft: RuleDraft | None) -> None:
        if path in wanted:
            out[path] = draft

    def pick(path: str, hits: list[Hit], describe: Callable[[Any], str] | None = None) -> RuleDraft | None:
        draft = choose(hits, page_text, describe)
        put(path, draft)
        return draft

    if not any(page.text.strip() for page in pages):
        return {path: None for path in wanted}
    pick("core.identity.title", _title(text_pages))
    pick("core.identity.issuing_agency", _issuing_agency(text_pages))
    pick("core.identity.tender_number", _tender_number(text_pages))
    pick("core.identity.tender_type_as_stated", _type_as_stated(text_pages))
    pick("core.key_dates.bid_submission_deadline", _bid_deadline(text_pages))
    pick("core.key_dates.pre_bid_meeting_date", _pre_bid(text_pages))
    pick("core.key_dates.nit_date", _nit_date(text_pages))
    pick("core.key_dates.query_deadline", _query_deadline(text_pages))
    pick("core.key_dates.technical_opening_date", _opening_date(text_pages))
    pick("core.key_dates.era_date", _era_date(text_pages))
    pick("core.key_dates.query_response_date", _query_response(text_pages))
    pick("core.key_dates.document_sale_end_date", _document_sale_end(text_pages))
    pick("core.key_dates.loa_date", _loa_date(text_pages))
    pick("core.key_dates.ppa_execution_date", _ppa_execution(text_pages))
    rupees = lambda value: f"₹{value:,.0f}"  # noqa: E731
    pick("core.guarantees.emd_per_mw_inr", _emd(text_pages), rupees)
    pick("core.guarantees.pbg_per_mw_inr", _pbg(text_pages), rupees)
    pick("sector.power.common.total_capacity_mw", _total_mw(text_pages), lambda v: f"{v:g} MW")
    pick("sector.power.common.total_capacity_mwh", _total_mwh(text_pages), lambda v: f"{v:g} MWh")
    pick("sector.power.common.min_bid_mw", _min_bid(text_pages), lambda v: f"{v:g} MW")
    pick("sector.power.common.max_bid_mw", _max_bid(text_pages), lambda v: f"{v:g} MW")
    constraint, sites = _location(text_pages)
    pick("sector.power.common.location_constraint", constraint)
    put("sector.power.common.named_states_or_sites", _list_draft(sites, page_text))
    pick("sector.power.common.ppa_tenure_years", _ppa_tenure(text_pages), lambda v: f"{v:g} years")
    months, references = _scod(text_pages)
    pick("sector.power.common.scod_months", months, lambda v: f"{v:g} months")
    pick("sector.power.common.scod_reference", references)
    pick("sector.power.common.tariff_ceiling_inr_per_kwh", _ceiling_tariff(text_pages), lambda v: f"₹{v:g}/kWh")
    pick("sector.power.common.greenshoe_capacity_mw", _greenshoe(text_pages), lambda v: f"{v:g} MW")
    pick("sector.power.common.part_capacity_allowed", _part_capacity(text_pages), lambda v: "yes" if v else "no")
    pick("sector.power.common.greenshoe_supply_start_date", _greenshoe_start(text_pages))
    pick("sector.power.common.greenshoe_same_tariff", _greenshoe_same_tariff(text_pages), lambda v: "yes" if v else "no")
    pick("sector.power.common.greenshoe_offer_date", _greenshoe_offer(text_pages))

    fdre_wanted = any(path.startswith("sector.power.fdre.") for path in wanted)
    if fdre_wanted:
        availability = pick("sector.power.fdre.assured_availability_percent", _availability(text_pages), lambda v: f"{v:g}%")
        if availability is not None:
            put(
                "sector.power.fdre.demand_profile",
                RuleDraft(
                    availability.quotes[0][1],
                    availability.confidence,
                    availability.rationale + " The value is the sentence that states the supply obligation.",
                    list(availability.quotes),
                ),
            )
        else:
            put("sector.power.fdre.demand_profile", None)
        peak_hours = pick("sector.power.fdre.peak_hours_per_day", _peak_hours(text_pages), lambda v: f"{v:g} hours")
        blocks = _peak_blocks(text_pages)
        window: RuleDraft | None = None
        if peak_hours is not None or blocks:
            parts = []
            quotes: list[tuple[int, str]] = list(peak_hours.quotes) if peak_hours else []
            if peak_hours is not None:
                parts.append(f"{peak_hours.value:g} hours a day")
            if blocks:
                page_no, start, end, items = blocks[0]
                parts.append(", ".join(f"{item['hours']:g} hours within {item['window_start']}–{item['window_end']}" for item in items))
                quote = (page_no, make_quote(page_text[page_no], start, end))
                if quote not in quotes:
                    quotes.append(quote)
            rationale = "Read by the rules reader from page" + ("s " if len({q[0] for q in quotes}) > 1 else " ") + ", ".join(
                str(p) for p in sorted({q[0] for q in quotes})
            ) + "."
            window = RuleDraft(": ".join(parts) if len(parts) == 2 else parts[0], CONFIDENCE, rationale, quotes)
        put("sector.power.fdre.peak_window_definition", window)
        pick("sector.power.fdre.storage_mandatory", _storage_mandatory(text_pages), lambda v: "yes" if v else "no")
        pick("sector.power.fdre.shortfall_compensation_multiple", _shortfall_multiple(text_pages), lambda v: f"{v:g} times")
        source_hits = _sources(text_pages)
        put("sector.power.fdre.permitted_re_sources", _sources_draft(source_hits))
        pick("sector.power.fdre.biomass_permitted", _biomass(text_pages, source_hits), lambda v: "yes" if v else "no")
        percent = lambda v: f"{v:g}%"  # noqa: E731
        pick("sector.power.fdre.annual_supply_min_pct", _annual_supply(text_pages), percent)
        pick("sector.power.fdre.monthly_supply_min_pct", _monthly_supply(text_pages), percent)
        pick("sector.power.fdre.peak_supply_min_pct", _availability(text_pages), percent)
        green_share = pick("sector.power.fdre.green_share_min_pct", _green_share(text_pages), percent)
        pick("sector.power.fdre.non_re_allowed", _non_re(text_pages), lambda v: "yes" if v else "no")
        pick("sector.power.fdre.min_solar_capacity_multiple", _solar_multiple(text_pages), lambda v: f"{v:g} times")
        pick("sector.power.fdre.market_sale_scope", _market_sale(text_pages))
        pick("sector.power.fdre.ppa_priority_before_sale", _ppa_priority(text_pages), lambda v: "yes" if v else "no")
        set_by = _peak_set_by(text_pages)
        if not set_by and blocks:  # the tender prints the windows itself
            set_by = [Hit("tender", page_no, start, end) for page_no, start, end, _ in blocks[:1]]
        pick("sector.power.fdre.peak_hours_set_by", set_by)
        pick("sector.power.fdre.supply_start_date", _supply_start(text_pages))
        cuf_min = choose(_cuf_min(text_pages), page_text, lambda v: f"{v:g}%")
        cuf_band = choose(_cuf_band(text_pages), page_text, lambda v: f"+{v[0] - 100:g}% / -{100 - v[1]:g}%")
        put(
            "sector.power.fdre.demand_profile_structured",
            _demand_structured(availability, peak_hours, blocks, cuf_min, cuf_band, text_pages, green_share),
        )
    put("core.penalties.shortfall_rules", _shortfall_rule(text_pages, page_text) if "core.penalties.shortfall_rules" in wanted else None)

    if any(path.startswith("sector.power.bess.") for path in wanted):
        power, energy = _bess_capacity(text_pages)
        pick("sector.power.bess.capacity_mw", power, lambda v: f"{v:g} MW")
        pick("sector.power.bess.capacity_mwh", energy, lambda v: f"{v:g} MWh")
        pick("sector.power.bess.cycles_per_day", _cycles(text_pages), lambda v: f"{v:g}")
        pick("sector.power.bess.round_trip_efficiency_guarantee_percent", _rte(text_pages), lambda v: f"{v:g}%")
        pick("sector.power.bess.availability_floor_percent", _bess_availability(text_pages), lambda v: f"{v:g}%")
    if "core.summary.plain_english_summary" in wanted:
        out["core.summary.plain_english_summary"] = _summary_draft(out)
    return out
