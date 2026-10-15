"""The adapter against a live tender_engine instance. Runs only when TENDER_ENGINE_LIVE_URL
is set (a local instance started from the tender_engine repository, or the deployed one).
Covers the HTTP contract the platform relies on: health, tender creation, version upload
with sha256 deduplication by the engine, versions, view and review-state shapes. Extraction
itself needs the engine's model key and is not exercised here."""

from __future__ import annotations

import io
import os

import pytest

from fdre_platform.integrations.tender_engine import HttpTenderEngine, candidates_from_review_state, candidates_from_view

LIVE = os.environ.get("TENDER_ENGINE_LIVE_URL")
pytestmark = pytest.mark.skipif(not LIVE, reason="TENDER_ENGINE_LIVE_URL not set")


def _pdf() -> bytes:
    import fitz

    doc = fitz.open()
    page = doc.new_page()
    page.insert_text(
        (72, 72), "Request for Selection for supply of 1200 MW Firm and Dispatchable power. The PPA shall be valid for a period of 25 years.", fontsize=10
    )
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


def test_live_contract():
    engine = HttpTenderEngine(LIVE, reviewer="platform-tests", admin_token=os.environ.get("TENDER_ENGINE_ADMIN_TOKEN", ""))
    health = engine.health()
    assert health["status"] == "ok"
    tender = engine.create_tender(tender_type="fdre", agency="NHPC", title="Adapter contract check", external_ref=None)
    assert tender.id and tender.tender_type == "fdre"
    v1 = engine.add_version(tender.id, filename="rfs.pdf", data=_pdf(), kind="original", issued_on=None, role="rfs", summary_of_change=None)
    assert v1.version_no == 1 and v1.kind == "original" and v1.document_ids
    v2 = engine.add_version(
        tender.id,
        filename="amendment-01.pdf",
        data=_pdf() + b"\n%amendment",
        kind="amendment",
        issued_on=None,
        role="amendment",
        summary_of_change="Amendment-01",
    )
    assert v2.version_no == 2 and v2.kind == "amendment"
    versions = engine.versions(tender.id)
    assert [v.version_no for v in versions] == [1, 2]
    view = engine.view(tender.id)
    assert view["tender_id"] == tender.id and "fields" in view and view["total"] > 0
    assert candidates_from_view(view) == []  # nothing decided yet without extraction
    state = engine.review_state(tender.id)
    assert state["object_type"] == "tender" and state["object_id"] == tender.id and "fields" in state
    assert candidates_from_review_state(state) == []
    amendments = engine.amendments(tender.id)
    assert amendments["tender_id"] == tender.id and len(amendments["versions"]) == 1 and amendments["versions"][0]["version_no"] == 2
