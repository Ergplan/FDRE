"""Read an uploaded tender into pages: text plus one box per character, index-aligned.

Ported from Ergplan/tender_engine core/services/parse.py (commit bd4959c), reimplemented
on pymupdf (the original reads text and boxes with pdfplumber). For each PDF page the text
is built from the characters of `page.get_text("rawdict")` in reading order: characters
inside a line are kept as given (with their boxes), and a "\n" with box None ends every
line (text blocks are not marked: in many tenders each printed line is its own block, so
a block break is not a paragraph break). DOCX and plain text become one page
without boxes, read with fdre_tender_rag.extract_text_from_upload.

Boxes are stored as one flat float array per page (CharBoxes), not one list per
character: a 260-page tender has close to a million characters.
"""

from __future__ import annotations

import hashlib
import threading
from array import array
from collections import OrderedDict
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from tender_intel.resolver import PageText

# A page with fewer extractable characters than this is treated as scanned: it has no
# usable text layer, so evidence cannot be located on it (core/services/parse.py).
MIN_TEXT_CHARS = 50
PDF_SUFFIXES = {".pdf"}
DOCX_SUFFIXES = {".docx"}
TEXT_SUFFIXES = {".txt", ".md", ".text", ".csv"}
_CACHE_SIZE = 2
_cache: OrderedDict[str, list[PageText]] = OrderedDict()
_cache_lock = threading.Lock()
# PyMuPDF is not thread-safe: every use of it in this package holds this lock (a job thread
# and a request thread may read PDFs at the same time).
PDF_LOCK = threading.RLock()
_NAN = float("nan")


class UnreadableDocument(ValueError):
    """The upload cannot be read as a PDF, DOCX or text document."""


class CharBoxes:
    """One [x0, top, x1, bottom] box per character, or None for a character the layout
    inserted. Supports len(), indexing, slicing and iteration like the list it replaces."""

    __slots__ = ("_data", "_n")

    def __init__(self, data: array | None = None, n: int = 0) -> None:
        self._data = data if data is not None else array("f")
        self._n = n

    @classmethod
    def empty(cls, n: int) -> "CharBoxes":
        """n characters without boxes (DOCX and text pages)."""
        return cls(None, n)

    def __len__(self) -> int:
        return self._n

    def _box(self, index: int) -> list[float] | None:
        if not self._data:
            return None
        x0 = self._data[4 * index]
        if x0 != x0:  # NaN: no box
            return None
        return [
            round(float(x0), 2),
            round(float(self._data[4 * index + 1]), 2),
            round(float(self._data[4 * index + 2]), 2),
            round(float(self._data[4 * index + 3]), 2),
        ]

    def __getitem__(self, key: int | slice) -> Any:
        if isinstance(key, slice):
            return [self._box(i) for i in range(*key.indices(self._n))]
        if key < 0:
            key += self._n
        if not 0 <= key < self._n:
            raise IndexError("character index out of range")
        return self._box(key)

    def __iter__(self) -> Iterator[list[float] | None]:
        for index in range(self._n):
            yield self._box(index)


def suffix_of(name: str) -> str:
    return Path(name or "").suffix.lower()


def is_pdf(name: str, payload: bytes) -> bool:
    return suffix_of(name) in PDF_SUFFIXES or payload[:5] == b"%PDF-"


def _pdf_page(page: Any, page_no: int) -> PageText:
    import pymupdf

    flags = pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES
    raw = page.get_text("rawdict", flags=flags)
    chars: list[str] = []
    boxes = array("f")
    nan4 = (_NAN, _NAN, _NAN, _NAN)
    for block in raw.get("blocks", []):
        if block.get("type", 0) != 0:
            continue
        lines = block.get("lines", [])
        if not lines:
            continue
        for index, line in enumerate(lines):
            if index:
                chars.append("\n")
                boxes.extend(nan4)
            for span in line.get("spans", []):
                for char in span.get("chars", []):
                    c = char.get("c", "")
                    if len(c) != 1:
                        c = (c or " ")[:1]
                    if c == "\x00":
                        c = " "
                    x0, y0, x1, y1 = char["bbox"]
                    chars.append(c)
                    boxes.extend((x0, y0, x1, y1))
        chars.append("\n")
        boxes.extend(nan4)
    text = "".join(chars)
    if len(boxes) != 4 * len(text):
        raise ValueError("text and character boxes are not aligned")
    has_text = sum(1 for c in text if not c.isspace()) >= MIN_TEXT_CHARS
    return PageText(page_no=page_no, text=text, char_boxes=CharBoxes(boxes, len(text)), has_text_layer=has_text)


def _read_pdf(payload: bytes) -> list[PageText]:
    with PDF_LOCK:
        return _read_pdf_locked(payload)


def _read_pdf_locked(payload: bytes) -> list[PageText]:
    import pymupdf

    try:
        document = pymupdf.open(stream=payload, filetype="pdf")
    except Exception as exc:  # noqa: BLE001 - any failure to open is an unreadable upload
        raise UnreadableDocument(f"The PDF could not be opened: {exc}") from exc
    try:
        if document.needs_pass:
            raise UnreadableDocument("The PDF is password protected.")
        if document.page_count == 0:
            raise UnreadableDocument("The PDF has no pages.")
        return [_pdf_page(page, number) for number, page in enumerate(document, start=1)]
    finally:
        document.close()


def _read_text_document(name: str, payload: bytes) -> list[PageText]:
    suffix = suffix_of(name)
    if suffix in DOCX_SUFFIXES:
        import fdre_tender_rag

        try:
            text, _ = fdre_tender_rag.extract_text_from_upload(name, payload)
        except Exception as exc:  # noqa: BLE001 - python-docx raises many kinds
            raise UnreadableDocument(f"The DOCX could not be read: {exc}") from exc
    else:
        text = payload.decode("utf-8", errors="replace")
    if not text.strip():
        raise UnreadableDocument("No readable text was found in the document.")
    has_text = sum(1 for c in text if not c.isspace()) >= MIN_TEXT_CHARS
    return [PageText(page_no=1, text=text, char_boxes=CharBoxes.empty(len(text)), has_text_layer=has_text)]


def check_readable(name: str, payload: bytes) -> None:
    """Raise UnreadableDocument when the upload cannot be read; cheap (no text extraction
    for a PDF)."""
    if not payload:
        raise UnreadableDocument("The file is empty.")
    if is_pdf(name, payload):
        import pymupdf

        with PDF_LOCK:
            try:
                document = pymupdf.open(stream=payload, filetype="pdf")
            except Exception as exc:  # noqa: BLE001
                raise UnreadableDocument(f"The PDF could not be opened: {exc}") from exc
            try:
                if document.needs_pass:
                    raise UnreadableDocument("The PDF is password protected.")
                if document.page_count == 0:
                    raise UnreadableDocument("The PDF has no pages.")
            finally:
                document.close()
        return
    suffix = suffix_of(name)
    if suffix not in DOCX_SUFFIXES | TEXT_SUFFIXES:
        raise UnreadableDocument("Upload a PDF, DOCX or text file.")
    if suffix in DOCX_SUFFIXES and payload[:2] != b"PK":
        raise UnreadableDocument("The DOCX could not be read: not a Word document.")


def read_pages(name: str, payload: bytes) -> list[PageText]:
    """Pages of the upload, numbered from 1. A PDF gives one PageText per page with
    character boxes; DOCX and text give one page without boxes. Raises UnreadableDocument.
    The last two documents read are kept in memory (keyed by content hash)."""
    check_readable(name, payload)
    key = hashlib.sha256(payload).hexdigest() + ("pdf" if is_pdf(name, payload) else suffix_of(name))
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    pages = _read_pdf(payload) if is_pdf(name, payload) else _read_text_document(name, payload)
    with _cache_lock:
        _cache[key] = pages
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
    return pages
