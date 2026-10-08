"""Read a tender: pages -> (model or rules) drafts -> located evidence -> validated fields.

Ported from Ergplan/tender_engine core/services/extract.py and core/services/validate.py
(commit bd4959c), made stateless: no database, no call log, one model call per section
(at most 40 pages, chosen by the section map and the section's keywords), sections read
concurrently. Model output is a draft until the deterministic checks below have run:

- every quote is looked up on its stated page, then the neighbouring pages, then the rest
  of the section's pages, then across a page break (threshold 85);
- a value without any quote is rejected; a value whose quotes cannot be found is shown
  with its confidence capped at 0.3;
- the value is coerced to its type (a failure is an issue, not a crash), then the range
  rule, the type's cross-field rules and the structured-number check run.

A field is "validated" when its value coerced, at least one quote was located and no
rule failed; "needs_review" when a value is there but something did not hold;
"not_found" when there is no value.
"""

from __future__ import annotations

import base64
import hashlib
import math
import os
import re
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, cast

from pydantic import BaseModel, create_model

from tender_intel import rules_reader
from tender_intel.pages import PDF_LOCK, is_pdf, read_pages
from tender_intel.resolver import Match, PageText, locate, resolve_pair
from tender_intel.rules import CROSS_FIELD_RULES, VALUE_RULE, range_rule, structured_numbers_quoted, value_in_quotes
from tender_intel.schema import TENDER_TYPES, FieldSpec, SectionSpec, TenderSchema, compile_type
from tender_intel.section_map import (
    PROMPT_NAME as SECTION_MAP_PROMPT,
    PROMPT_VERSION as SECTION_MAP_VERSION,
    SectionMapOutput,
    clean_sections,
    normalise_kind,
    page_digest,
)
from tender_intel.values import JSON_KINDS, coerce, display

ENGINE = "tender_intel"
MODES = ("auto", "llm", "rules")
UNLOCATED_CONFIDENCE_CAP = 0.3
MATCH_THRESHOLD = 85.0
MAX_PAGES_PER_CALL = 40
KEYWORD_PAGES = 12
MAX_PDF_BYTES = 20 * 1024 * 1024
MAX_TOKENS = 16000
DEFAULT_CONCURRENCY = 4
Progress = Callable[[int, int, str], None]
_PY_TYPES: dict[str, Any] = {
    "string": str,
    "number": float,
    "integer": int,
    "boolean": bool,
    "string_list": list[str],
}

# Keyword weights for detecting the tender type; a score is the sum of weight x
# log(1 + occurrences). generation and ipp are fallbacks with small weights.
TYPE_KEYWORDS: dict[str, list[tuple[str, float]]] = {
    "fdre": [
        (r"firm\s*(?:and|&)\s*dispatchable", 3.0),
        (r"\bfdre\b", 3.0),
        (r"assured\s+peak", 2.0),
        (r"demand\s+fulfil+ment\s+ratio", 2.0),
        (r"round[\s-]+the[\s-]+clock", 3.0),
        (r"\brtc\b", 2.0),
        (r"peak\s+hours", 1.0),
    ],
    "bess": [
        (r"battery\s+energy\s+storage", 2.0),
        (r"\bbess\b", 1.0),
        (r"\bstandalone\b", 1.0),
        (r"\bmwh\b", 1.0),
        (r"\bcharging\b", 0.5),
        (r"\bdischarging\b", 0.5),
    ],
    "hybrid": [(r"wind[\s-]+solar\s+hybrid", 3.0), (r"hybrid\s+power", 2.0)],
    "solar": [(r"\bsolar\b", 0.8)],
    "wind": [(r"\bwind\b", 0.8)],
    "transmission": [
        (r"transmission\s+system", 1.0),
        (r"tbcb\s+transmission", 3.0),
        (r"\bsubstation\b", 0.5),
        (r"\bkv\s+(?:d/c\s+|s/c\s+)?line", 1.0),
    ],
    "epc": [(r"\bepc\b", 2.0), (r"engineering,?\s+procurement\s+and\s+construction", 3.0)],
    "generation": [(r"\bthermal\b", 0.3), (r"\bcoal\b", 0.3), (r"pumped\s+storage", 0.3)],
    "ipp": [(r"independent\s+power\s+producer", 0.5)],
}
DEFAULT_TYPE = "fdre"


# ----------------------------------------------------------------------------- types


def detect_tender_type(pages: list[PageText]) -> tuple[str, dict[str, float]]:
    """The tender type whose keywords the document uses most, and every type's score."""
    text = "\n".join(page.text for page in pages).lower()
    scores: dict[str, float] = {}
    for tender_type in TENDER_TYPES:
        score = 0.0
        for pattern, weight in TYPE_KEYWORDS.get(tender_type, []):
            count = len(re.findall(pattern, text))
            score += weight * math.log1p(count)
        scores[tender_type] = round(score, 2)
    best = max(scores, key=lambda name: (scores[name], name == DEFAULT_TYPE))
    return (best if scores[best] > 0 else DEFAULT_TYPE), scores


def require_llm() -> bool:
    """TENDER_INTEL_REQUIRE_LLM=1: tenders are read only by the model (the tender_engine
    reading); the rules reader is never used, and a read that cannot use the model fails."""
    return os.environ.get("TENDER_INTEL_REQUIRE_LLM", "").strip().lower() in ("1", "true", "yes", "on")


def resolve_mode(name: str, payload: bytes, mode: str, llm_ok: bool) -> str:
    """"llm" when asked for (or "auto" with a model available) and the file is a PDF;
    "rules" otherwise. Raises ValueError for an unknown mode or "llm" without a model, and,
    when the model reading is required, for anything that would be read by rules."""
    if mode not in MODES:
        raise ValueError(f"unknown mode {mode!r}; one of {list(MODES)}")
    if require_llm():
        if not llm_ok:
            raise ValueError("This engine reads tenders only with the model (TENDER_INTEL_REQUIRE_LLM) and no ANTHROPIC_API_KEY is set.")
        if mode == "rules":
            raise ValueError("Rule-based reading is switched off on this engine (TENDER_INTEL_REQUIRE_LLM).")
        if not is_pdf(name, payload):
            raise ValueError("The model reading needs a PDF; upload the tender as PDF.")
    if mode == "llm" and not llm_ok:
        raise ValueError("mode=llm needs ANTHROPIC_API_KEY")
    if mode == "rules":
        return "rules"
    if is_pdf(name, payload) and (mode == "llm" or llm_ok):
        return "llm"
    return "rules"


# ----------------------------------------------------------------------------- drafts


@dataclass
class Quote:
    stated_page: int  # document page the quote is said to be on
    text: str
    in_range: bool = True  # the model's page position was inside the attached pages


@dataclass
class Draft:
    value: Any
    confidence: float
    rationale: str
    quotes: list[Quote] = field(default_factory=list)
    window: list[int] = field(default_factory=list)


class EvidenceQuote(BaseModel):
    page_no: int
    quote: str


@lru_cache(maxsize=256)
def _kind_model(kind: str) -> type[BaseModel]:
    make = cast(Any, create_model)
    return cast(
        type[BaseModel],
        make(
            f"Extracted_{kind}",
            value=(_PY_TYPES[kind] | None, ...),
            confidence=(float, ...),
            rationale=(str, ...),
            evidence=(list[EvidenceQuote], ...),
        ),
    )


@lru_cache(maxsize=256)
def _group_model(tender_type: str, section: str) -> type[BaseModel]:
    schema = compile_type(tender_type)
    return build_group_model(section, schema.fields_in(section))


def build_group_model(section: str, fields: list[FieldSpec]) -> type[BaseModel]:
    """The structured-output model for one section: every field REQUIRES value,
    confidence, rationale and evidence."""
    make = cast(Any, create_model)
    properties = {spec.key: (_kind_model(JSON_KINDS[spec.type]), ...) for spec in fields}
    return cast(type[BaseModel], make(f"Extract_{section}", **properties))


def select_pages(
    keywords_: list[str],
    section_kinds: list[str],
    sections: list[tuple[int, int, str, str]],
    page_texts: dict[int, str],
    *,
    max_pages: int,
    fallback_pages: int,
    keyword_pages: int = 0,
) -> list[int]:
    """Pages for a section: map sections whose kind or heading the hints name, plus up to
    `keyword_pages` pages outside them, taken keyword by keyword in turn. If no mapped
    section matches, every page that mentions a keyword; if still none, the opening pages.
    sections are (start_page, end_page, heading, kind)."""
    kinds = {normalise_kind(kind) for kind in section_kinds}
    keywords = [keyword.lower() for keyword in keywords_ if keyword.strip()]
    lowered = {page_no: text.lower() for page_no, text in page_texts.items()}
    hits = {page_no: sum(text.count(keyword) for keyword in keywords) for page_no, text in lowered.items()}
    pages: set[int] = set()
    for start, end, heading, kind in sections:
        if kind in kinds or any(keyword in heading.lower() for keyword in keywords):
            pages.update(p for p in range(start, end + 1) if p in page_texts)
    if not pages:
        pages = {page_no for page_no, count in hits.items() if count > 0}
    else:
        pages.update(_keyword_pages(keywords, lowered, pages, keyword_pages))
    if not pages:
        pages = set(sorted(page_texts)[:fallback_pages])
    if len(pages) > max_pages:
        ranked = sorted(pages, key=lambda page_no: (-hits.get(page_no, 0), page_no))
        pages = set(ranked[:max_pages])
    return sorted(pages)


def _keyword_pages(keywords: list[str], lowered: dict[int, str], taken: set[int], budget: int) -> list[int]:
    """Up to `budget` pages not yet taken: round-robin over the keywords, each giving its
    pages in order of most mentions."""
    ranked = []
    for keyword in keywords:
        counts = {page_no: text.count(keyword) for page_no, text in lowered.items()}
        ranked.append(sorted((p for p, c in counts.items() if c > 0), key=lambda p, c=counts: (-c[p], p)))
    chosen: list[int] = []
    for rank in range(max((len(pages) for pages in ranked), default=0)):
        for pages in ranked:
            if len(chosen) >= budget:
                return chosen
            if rank < len(pages) and pages[rank] not in taken and pages[rank] not in chosen:
                chosen.append(pages[rank])
    return chosen


def _sub_pdf(source: Any, pages: list[int]) -> bytes:
    """A PDF holding exactly the given 1-based pages, in order. The same pages always give
    the same bytes (no fresh file id)."""
    import pymupdf

    out: Any = pymupdf.open()
    try:
        start = previous = pages[0]
        for page_no in [*pages[1:], None]:
            if page_no is not None and page_no == previous + 1:
                previous = page_no
                continue
            out.insert_pdf(source, from_page=start - 1, to_page=previous - 1)
            if page_no is not None:
                start = previous = page_no
        return cast(bytes, out.tobytes(garbage=3, deflate=True, no_new_id=True))
    finally:
        out.close()


def _key_text(key: Any) -> str:
    notes = [key.type]
    if key.unit:
        notes.append(key.unit)
    if key.enum:
        notes.append("one of: " + ", ".join(key.enum))
    return f"`{key.name}` ({'; '.join(notes)})"


def _keys_text(spec: FieldSpec) -> str:
    """How a record is written and which keys it has."""
    keys = spec.keys or []
    if spec.type.endswith("_list"):
        how = (
            "Write the value as a list with one string per item, each "
            "`key: value | key: value`, leaving out keys the pages do not state"
        )
    else:
        how = (
            "Write the value as a list of strings, one `key: value` per key the pages "
            "state; leave out a key they do not state, never write 0 for it"
        )
    parts = []
    for key in keys:
        if key.keys:
            subs = ", ".join(_key_text(sub) for sub in key.keys)
            parts.append(
                f"`{key.name}` (a list: one string per item, written "
                f"`{key.name}: sub=value; sub=value`, with sub-keys {subs})"
            )
        else:
            parts.append(_key_text(key))
    return (
        f"{how}. Numbers as plain digits in the key's unit, without separators or unit "
        "words; yes or no for a yes/no key. Quote the passages that state these numbers. "
        "Keys: " + "; ".join(parts)
    )


def instructions(name: str, schema: TenderSchema, section: SectionSpec, fields: list[FieldSpec], chunk: list[int]) -> str:
    mapping = "\n".join(
        f"attached page {position} = document page {page_no}" for position, page_no in enumerate(chunk, start=1)
    )
    lines = []
    for spec in fields:
        parts = [f"- `{spec.key}`: {spec.label}. Type: {spec.type}"]
        if spec.unit:
            parts.append(f"unit: {spec.unit}")
        if spec.enum:
            parts.append(f"one of: {', '.join(spec.enum)}")
        if spec.help:
            parts.append(spec.help)
        if spec.keys:
            parts.append(_keys_text(spec))
        elif spec.item_keys:
            parts.append(
                "Write the value as a list with one string per item, each `key: value | key: value`, "
                f"with keys {', '.join(spec.item_keys)}"
            )
        lines.append("; ".join(parts))
    return (
        f"Document: {name}\n"
        f"The attached PDF holds {len(chunk)} of its pages.\n{mapping}\n\n"
        f"Extract the fields of group `{section.name}` (schema tender.{schema.tender_type} {schema.version}):\n"
        + "\n".join(lines)
        + "\n\nIn evidence, page_no is the attached page position (1 to "
        f"{len(chunk)}), not the document page number."
    )


def _concurrency() -> int:
    try:
        return max(1, int(os.environ.get("TENDER_INTEL_CONCURRENCY") or DEFAULT_CONCURRENCY))
    except ValueError:
        return DEFAULT_CONCURRENCY


def _llm_drafts(
    name: str,
    payload: bytes,
    pages: list[PageText],
    schema: TenderSchema,
    client: Any,
    progress: Progress,
    warnings: list[str],
    usage: dict[str, Any],
) -> tuple[dict[str, Draft], int]:
    """Drafts for every field of the sections read, and how many section calls succeeded."""
    import pymupdf

    total = 1 + len(schema.sections)
    progress(0, total, "Mapping the document's sections")
    digest = "\n\n".join(page_digest(page.page_no, page.text) for page in pages)
    mapped: list[tuple[int, int, str, str]] = []
    usage["calls"] += 1
    try:
        parsed, used = client.call(
            SECTION_MAP_PROMPT,
            SECTION_MAP_VERSION,
            [{"type": "text", "text": f"Document: {name}\nPages: 1 to {len(pages)}\n\n{digest}"}],
            SectionMapOutput,
            MAX_TOKENS,
        )
        _add_usage(usage, used)
        mapped = [
            (item.start_page, item.end_page, item.heading, normalise_kind(item.kind))
            for item in clean_sections(cast(SectionMapOutput, parsed).sections, len(pages))
        ]
    except Exception as exc:  # noqa: BLE001 - the run goes on with keyword pages
        warnings.append(f"The section map failed ({_short(exc)}); pages were chosen by keywords.")
    progress(1, total, "Section map")

    page_texts = {page.page_no: page.text for page in pages}
    plans: list[tuple[SectionSpec, list[int], str]] = []
    with PDF_LOCK, pymupdf.open(stream=payload, filetype="pdf") as source:
        for section in schema.sections:
            cap = min(section.max_pages or MAX_PAGES_PER_CALL, MAX_PAGES_PER_CALL)
            chunk = select_pages(
                section.keywords,
                section.section_kinds,
                mapped,
                page_texts,
                max_pages=cap,
                fallback_pages=MAX_PAGES_PER_CALL,
                keyword_pages=KEYWORD_PAGES,
            )
            if not chunk:
                continue
            data = _sub_pdf(source, chunk)
            while len(data) > MAX_PDF_BYTES and len(chunk) > 1:
                chunk = chunk[: len(chunk) // 2]
                data = _sub_pdf(source, chunk)
                if len(data) <= MAX_PDF_BYTES:
                    warnings.append(f"{section.label}: the selected pages were too large for one call; read {len(chunk)} pages.")
            plans.append((section, chunk, base64.standard_b64encode(data).decode("ascii")))

    drafts: dict[str, Draft] = {}

    def run(plan: tuple[SectionSpec, list[int], str]) -> tuple[BaseModel, dict[str, int]]:
        section, chunk, data = plan
        fields = schema.fields_in(section.name)
        blocks = [
            {
                "type": "document",
                "source": {"type": "base64", "media_type": "application/pdf", "data": data},
                "title": name,
            },
            {"type": "text", "text": instructions(name, schema, section, fields, chunk)},
        ]
        return client.call(section.prompt, section.prompt_version, blocks, _group_model(schema.tender_type, section.name), MAX_TOKENS)

    done = 1
    succeeded = 0
    with ThreadPoolExecutor(max_workers=_concurrency()) as pool:
        futures = {pool.submit(run, plan): plan for plan in plans}
        for future in as_completed(futures):
            section, chunk, _ = futures[future]
            fields = schema.fields_in(section.name)
            usage["calls"] += 1
            try:
                parsed, used = future.result()
                _add_usage(usage, used)
                succeeded += 1
                for spec in fields:
                    drafts[spec.path] = _draft_from_answer(getattr(parsed, spec.key), chunk)
            except Exception as exc:  # noqa: BLE001 - one section must not fail the run
                message = f"model call failed: {_short(exc)}"
                warnings.append(f"{section.label}: {message}")
                for spec in fields:
                    drafts[spec.path] = Draft(None, 0.0, message, [], chunk)
            done += 1
            progress(done, total, section.label)
    return drafts, succeeded


def _draft_from_answer(item: Any, chunk: list[int]) -> Draft:
    if item.value is None:
        return Draft(None, 0.0, item.rationale or "The model returned no value.", [], chunk)
    quotes = []
    for evidence in item.evidence:
        if not evidence.quote.strip():
            continue
        in_range = 1 <= evidence.page_no <= len(chunk)
        stated = chunk[evidence.page_no - 1] if in_range else chunk[0]
        quotes.append(Quote(stated, evidence.quote, in_range))
    confidence = min(max(float(item.confidence), 0.0), 1.0) if math.isfinite(float(item.confidence)) else 0.0
    return Draft(item.value, confidence, item.rationale, quotes, chunk)


def _add_usage(usage: dict[str, Any], used: dict[str, int]) -> None:
    usage["input_tokens"] += int(used.get("input_tokens", 0))
    usage["output_tokens"] += int(used.get("output_tokens", 0))


def _short(exc: Exception) -> str:
    text = f"{type(exc).__name__}: {exc}"
    return text if len(text) <= 300 else text[:297] + "..."


def _rules_drafts(pages: list[PageText], schema: TenderSchema) -> dict[str, Draft]:
    found = rules_reader.read(pages, schema.paths)
    drafts: dict[str, Draft] = {}
    for spec in schema.fields:
        if spec.path not in rules_reader.RULE_PATHS:
            drafts[spec.path] = Draft(None, 0.0, rules_reader.NOT_READ)
            continue
        draft = found.get(spec.path)
        if draft is None:
            drafts[spec.path] = Draft(None, 0.0, rules_reader.NOT_FOUND)
            continue
        quotes = [Quote(page, text, True) for page, text in draft.quotes]
        drafts[spec.path] = Draft(draft.value, draft.confidence, draft.rationale, quotes, [q.stated_page for q in quotes])
    return drafts


# ----------------------------------------------------------------------------- evidence


def resolve_quote(quote: Quote, window: list[int], pages: dict[int, PageText], threshold: float = MATCH_THRESHOLD) -> dict[str, Any]:
    """Locate the quote: stated page, then adjacent pages, then the rest of the window,
    then across a page break."""
    stated, in_range = quote.stated_page, quote.in_range
    order: list[tuple[str, list[int]]] = [
        ("stated_page", [stated] if in_range else []),
        ("adjacent_page", [stated - 1, stated + 1] if in_range else []),
        ("window_page", [page_no for page_no in window if page_no != stated or not in_range]),
    ]
    tried: set[int] = set()
    for resolution, candidates in order:
        best: Match | None = None
        for page_no in candidates:
            if page_no in tried:
                continue
            tried.add(page_no)
            page = pages.get(page_no)
            found = locate(quote.text, page, threshold) if page else None
            if found and (best is None or found.score > best.score):
                best = found
        if best is not None:
            return _evidence(quote.text, best.page_no, True, best.method, best.score, resolution, best.bbox)
    if in_range:
        for first_no in (stated, stated - 1):
            first, second = pages.get(first_no), pages.get(first_no + 1)
            across = resolve_pair(quote.text, first, second, threshold) if first and second else None
            if isinstance(across, Match):
                resolution = "stated_page" if across.page_no == stated else "adjacent_page"
                return _evidence(quote.text, across.page_no, True, across.method, across.score, resolution, across.bbox)
    return _evidence(quote.text, stated, False, None, None, "unresolved", None)


def _evidence(
    quote: str, page: int, located: bool, method: str | None, score: float | None, resolution: str, bbox: Any
) -> dict[str, Any]:
    return {
        "page": page,
        "quote": quote,
        "located": located,
        "method": method,
        "score": score,
        "resolution": resolution,
        "bbox": [round(float(x), 2) for x in bbox] if bbox else None,
    }


# ----------------------------------------------------------------------------- validation


@dataclass
class _Field:
    spec: FieldSpec
    draft: Draft
    value: Any = None
    coerced: bool = False
    confidence: float = 0.0
    status: str = "not_found"
    evidence: list[dict[str, Any]] = field(default_factory=list)
    issues: list[dict[str, Any]] = field(default_factory=list)


def _issue(rule: str, message: str, warning: bool = False) -> dict[str, Any]:
    return {"rule": rule, "message": message, "warning": warning}


def finalise(schema: TenderSchema, drafts: dict[str, Draft], pages: list[PageText]) -> tuple[list[_Field], list[dict[str, Any]]]:
    """Resolve, coerce and validate every field. Returns the fields and the rule outcomes."""
    by_no = {page.page_no: page for page in pages}
    fields: list[_Field] = []
    for spec in schema.fields:
        draft = drafts.get(spec.path) or Draft(None, 0.0, "The field was not read.")
        item = _Field(spec, draft)
        fields.append(item)
        if draft.value is None:
            continue
        quotes = [quote for quote in draft.quotes if quote.text.strip()]
        item.confidence = draft.confidence
        try:
            item.value, item.coerced = coerce(draft.value, spec), True
        except ValueError as exc:
            item.value = draft.value
            item.issues.append(_issue("type", f"not a valid {spec.type}: {exc}"))
        if not quotes:
            item.status = "rejected"
            item.issues.append(_issue("evidence_required", "a value came without a quote; it is not shown for review"))
            continue
        item.evidence = [resolve_quote(quote, draft.window, by_no) for quote in quotes]
        located = [evidence for evidence in item.evidence if evidence["located"]]
        if not located:
            item.confidence = min(item.confidence, UNLOCATED_CONFIDENCE_CAP)
            stated = ", ".join(f"p.{e['page']}" for e in item.evidence)
            item.issues.append(_issue("evidence_not_located", f"evidence not located (stated on {stated})"))
        elif len(located) < len(item.evidence):
            missing = len(item.evidence) - len(located)
            item.issues.append(
                _issue("evidence_not_located", f"{missing} of {len(item.evidence)} quotes not located", warning=True)
            )
        if item.coerced:
            outcome = range_rule(spec, item.value)
            if outcome is not None and not outcome[1]:
                item.issues.append(_issue(outcome[0], outcome[2]))
        item.status = "needs_review"  # settled below

    typed = {item.spec.path: item for item in fields if item.coerced and item.status != "rejected"}
    values = {path: item.value for path, item in typed.items()}
    outcomes: list[dict[str, Any]] = []
    for rule_name in schema.cross_field_rules:
        rule = CROSS_FIELD_RULES.get(rule_name)
        if rule is None:
            continue
        for outcome in rule(values):
            outcomes.append(
                {
                    "rule": rule_name,
                    "fields": list(outcome.field_paths),
                    "passed": outcome.passed,
                    "message": outcome.message,
                    "warning": outcome.warning,
                }
            )
            if outcome.passed:
                continue
            for path in outcome.field_paths:
                if path in typed:
                    typed[path].issues.append(_issue(rule_name, outcome.message, outcome.warning))
    if "structured_numbers_quoted" in schema.run_rules:
        for item in typed.values():
            outcome = structured_numbers_quoted(item.spec, item.value, [quote.text for quote in item.draft.quotes])
            if outcome is None:
                continue
            outcomes.append(
                {
                    "rule": "structured_numbers_quoted",
                    "fields": [item.spec.path],
                    "passed": outcome.passed,
                    "message": outcome.message,
                    "warning": False,
                }
            )
            if not outcome.passed:
                item.issues.append(_issue("structured_numbers_quoted", outcome.message))

    # FDRE addition: a single number or date must be printed in its own quotes
    for item in typed.values():
        outcome = value_in_quotes(item.spec, item.value, [quote.text for quote in item.draft.quotes])
        if outcome is None:
            continue
        outcomes.append({"rule": VALUE_RULE, "fields": [item.spec.path], "passed": outcome.passed, "message": outcome.message, "warning": False})
        if not outcome.passed:
            item.issues.append(_issue(VALUE_RULE, outcome.message))

    for item in fields:
        if item.draft.value is None or item.status == "rejected":
            continue
        failed = any(not issue["warning"] for issue in item.issues)
        located = any(evidence["located"] for evidence in item.evidence)
        item.status = "validated" if item.coerced and located and not failed else "needs_review"
    return fields, outcomes


def _field_json(item: _Field) -> dict[str, Any]:
    spec = item.spec
    value = item.value if item.draft.value is not None else None
    return {
        "path": spec.path,
        "key": spec.key,
        "label": spec.label,
        "type": spec.type,
        "unit": spec.unit,
        "required": spec.required,
        "help": spec.help,
        "enum": spec.enum,
        "value": value,
        "display": display(value, spec) if value is not None else "",
        "confidence": round(item.confidence, 3) if value is not None else 0.0,
        "status": item.status,
        "rationale": item.draft.rationale,
        "evidence": item.evidence,
        "issues": item.issues,
    }


# ----------------------------------------------------------------------------- entry point


def read_tender(
    name: str,
    payload: bytes,
    tender_type: str = "auto",
    mode: str = "auto",
    progress: Progress | None = None,
    sdk: Any | None = None,
) -> dict[str, Any]:
    """Read one tender document and return the result JSON (see docs/TENDER_INTEL.md).

    tender_type: "auto" or one of TENDER_TYPES. mode: "auto" (the model when a key is set
    and the file is a PDF), "llm" or "rules". sdk: an Anthropic SDK object to use instead of
    the real client (tests). Raises ValueError for a bad mode or an unreadable file and
    LookupError for an unknown tender type."""
    started = time.monotonic()
    report: Progress = progress or (lambda done, total, step: None)
    if tender_type != "auto" and tender_type not in TENDER_TYPES:
        raise LookupError(f"unknown tender type {tender_type!r}; one of {TENDER_TYPES}")
    from tender_intel.llm import llm_available

    llm_ok = sdk is not None or llm_available()
    resolved = resolve_mode(name, payload, mode, llm_ok)
    warnings: list[str] = []
    if mode == "llm" and resolved == "rules":
        warnings.append("The model reads PDF pages only; this file was read in rules mode.")
    pages = read_pages(name, payload)
    detected, scores = detect_tender_type(pages)
    chosen, source = (detected, "auto") if tender_type == "auto" else (tender_type, "user")
    schema = compile_type(chosen)
    scanned = [page.page_no for page in pages if not page.has_text_layer]
    if scanned and len(scanned) == len(pages):
        warnings.append("No page has a text layer (a scanned document): evidence cannot be located.")
    elif scanned:
        warnings.append(f"{len(scanned)} page(s) have no text layer; evidence on them cannot be located.")

    usage: dict[str, Any] = {"calls": 0, "input_tokens": 0, "output_tokens": 0, "seconds": 0.0}
    model: str | None = None
    drafts: dict[str, Draft] | None = None
    if resolved == "llm":
        from tender_intel.llm import LLMClient, default_client

        try:
            client = LLMClient(sdk) if sdk is not None else default_client()
            model = client.model
        except Exception as exc:  # noqa: BLE001 - no model reachable: read by rules
            if require_llm():
                raise RuntimeError(f"The model could not be reached ({_short(exc)}); rule-based reading is switched off.") from exc
            warnings.append(f"The model could not be reached ({_short(exc)}); the tender was read in rules mode.")
            resolved, model = "rules", None
        else:
            drafts, succeeded = _llm_drafts(name, payload, pages, schema, client, report, warnings, usage)
            if succeeded == 0 and schema.sections:
                if require_llm():
                    raise RuntimeError("Every model call failed; rule-based reading is switched off. " + " ".join(warnings[-3:]))
                warnings.append("Every model call failed; the tender was read in rules mode instead.")
                resolved, model, drafts = "rules", None, None
    if drafts is None:
        report(0, 1, "Reading with rules")
        drafts = _rules_drafts(pages, schema)
        report(1, 1, "Rules read")
    fields, outcomes = finalise(schema, drafts, pages)

    by_section: dict[str, list[dict[str, Any]]] = {section.name: [] for section in schema.sections}
    for item in fields:
        by_section[item.spec.section].append(_field_json(item))
    values = {
        item.spec.path: item.value
        for item in fields
        if item.status in ("validated", "needs_review") and item.coerced
    }
    statuses = [item.status for item in fields]
    usage["seconds"] = round(time.monotonic() - started, 2)
    return {
        "engine": ENGINE,
        "mode": resolved,
        "model": model,
        "document": {
            "name": name,
            "pages": len(pages),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "text_pages": len(pages) - len(scanned),
            "scanned_pages": scanned,
        },
        "tender_type": chosen,
        "type_source": source,
        "type_scores": scores,
        "sections": [
            {"name": section.name, "label": section.label, "fields": by_section[section.name]}
            for section in schema.sections
        ],
        "values": values,
        "rules": outcomes,
        "counts": {
            "fields": len(fields),
            "found": sum(1 for item in fields if item.draft.value is not None),
            "located": sum(1 for item in fields if any(e["located"] for e in item.evidence)),
            "validated": statuses.count("validated"),
            "needs_review": statuses.count("needs_review"),
            "not_found": statuses.count("not_found"),
            "rejected": statuses.count("rejected"),
            "required_missing": [item.spec.path for item in fields if item.spec.required and item.spec.path not in values],
        },
        "usage": usage,
        "warnings": warnings,
    }
