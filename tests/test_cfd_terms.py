"""Every SECI CfD-I term the CfD bid tab uses (web/src/cfd/terms.js) is quoted word for word on its page.

The CfD Agreement and Amendments 02 and 03 are the user's documents and are not in the repository:
set CFD_DOCS_DIR to a folder holding them (file names as in DOCUMENTS), or the copies made during
development are picked up from the session scratchpad.
"""
from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = {"cfda": "agreement", "amd2": "amd2", "amd3": "amd3"}


def _documents() -> dict[str, Path] | None:
    node = shutil.which("node")
    if node is None:
        return None
    script = "import { DOCUMENTS, TERMS } from './web/src/cfd/terms.js'; console.log(JSON.stringify({ DOCUMENTS, TERMS }));"
    out = subprocess.run([node, "--input-type=module", "-e", script], cwd=ROOT, capture_output=True, text=True, check=True)
    data = json.loads(out.stdout)
    found: dict[str, Path] = {}
    base = os.environ.get("CFD_DOCS_DIR")
    for doc in data["DOCUMENTS"]:
        candidates = [Path(base) / doc["file"]] if base else []
        candidates += [Path(p) for p in sorted(glob.glob(os.path.join(tempfile.gettempdir(), "claude-*", "*", "*", "scratchpad", "cfd", SCRATCH[doc["id"]], "doc.pdf")))]
        hit = next((c for c in candidates if c.is_file()), None)
        if hit is None:
            return None
        found[doc["id"]] = hit
    _documents.terms = data["TERMS"]  # type: ignore[attr-defined]
    return found


def _norm(text: str) -> str:
    return " ".join(re.sub(r"-[ \t]*\n\s*", "-", text).split())


def test_cfd_terms_quote_the_documents_word_for_word():
    docs = _documents()
    if docs is None:
        pytest.skip("the SECI CfD-I documents are not available (set CFD_DOCS_DIR), or node is not installed")
    fitz = pytest.importorskip("fitz")
    pages = {doc_id: [page.get_text("text") for page in fitz.open(path)] for doc_id, path in docs.items()}
    terms = _documents.terms  # type: ignore[attr-defined]
    assert len(terms) >= 50
    for term in terms:
        text = pages[term["doc"]][term["page"] - 1]
        assert _norm(term["quote"]) in _norm(text), (term["id"], term["doc"], term["page"])
