"""Tender intelligence: read an Indian power tender into typed, evidence-backed fields.

Ported from Ergplan/tender_engine (commit bd4959c) as a stateless package: the domain
packs (YAML schemas and versioned prompts), value types, the evidence resolver, the
section map and per-section extraction, and the deterministic validation rules. Without
a model (no ANTHROPIC_API_KEY, or a DOCX/text upload) a rules reader fills the headline
fields, each with a verbatim quote. See docs/TENDER_INTEL.md.
"""

from tender_intel.extract import MODES, detect_tender_type, read_tender
from tender_intel.llm import llm_available
from tender_intel.schema import TENDER_TYPES, catalog, compile_type

__all__ = [
    "MODES",
    "TENDER_TYPES",
    "catalog",
    "compile_type",
    "detect_tender_type",
    "llm_available",
    "read_tender",
]
