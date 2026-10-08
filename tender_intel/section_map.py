"""The section map: one model pass over a digest of every page, so later calls read only
the pages they need.

Ported from Ergplan/tender_engine core/services/section_map.py (commit bd4959c); the
database writes are gone, the digest, heading detection and cleaning are unchanged.
"""

from __future__ import annotations

import re

from pydantic import BaseModel

PROMPT_NAME = "section_map"
PROMPT_VERSION = "v1"
PAGE_PREVIEW_CHARS = 400
MAX_HEADINGS_PER_PAGE = 6
# Clause-style heading detection adapted from FDRE fdre_tender_rag.py (CLAUSE_RE).
_HEADING = re.compile(
    r"^(?:(?:section|annexure|annex|format|chapter|article|schedule|appendix|part)\b[\s\-:–.]*\S.{0,90}"
    r"|\d{1,2}(?:\.\d{1,2}){0,2}\.?\s+[A-Z][^.]{3,90})$",
    re.IGNORECASE,
)


class MappedSection(BaseModel):
    start_page: int
    end_page: int
    heading: str
    kind: str
    confidence: float


class SectionMapOutput(BaseModel):
    sections: list[MappedSection]


def page_digest(page_no: int, text: str) -> str:
    preview = " ".join(text[:PAGE_PREVIEW_CHARS].split())
    lines = [f"=== page {page_no} ===", preview or "(no extractable text)"]
    headings = detect_headings(text)
    if headings:
        lines.append("Heading-like lines: " + " | ".join(headings))
    return "\n".join(lines)


def detect_headings(text: str) -> list[str]:
    found: list[str] = []
    for raw in text.splitlines():
        line = " ".join(raw.split())
        if not 6 <= len(line) <= 100:
            continue
        letters = [char for char in line if char.isalpha()]
        all_caps = len(letters) >= 6 and all(char.isupper() for char in letters)
        if (_HEADING.match(line) or all_caps) and line not in found:
            found.append(line)
        if len(found) == MAX_HEADINGS_PER_PAGE:
            break
    return found


def normalise_kind(kind: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", kind.strip().lower()).strip("_")[:100] or "other"


def clean_sections(sections: list[MappedSection], page_count: int) -> list[MappedSection]:
    """Clamp ranges to the document and drop ranges that are empty or inverted."""
    cleaned = []
    for item in sorted(sections, key=lambda s: (s.start_page, s.end_page)):
        start, end = max(item.start_page, 1), min(item.end_page, page_count)
        if start <= end:
            cleaned.append(item.model_copy(update={"start_page": start, "end_page": end}))
    return cleaned
