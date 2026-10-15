"""Tender documents: store once (sha256 dedupe within the tender), keep publication order,
effective dates and supersession, push to tender_engine when it is live, and produce
requirement candidates from whichever extractor is available."""

from __future__ import annotations

import hashlib
from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from fdre_platform.config import Settings
from fdre_platform.integrations.tender_engine import Candidate, TenderEngine, TenderEngineError, candidates_from_review_state, candidates_from_view
from fdre_platform.models import DOCUMENT_KINDS, Tender, TenderDocument
from fdre_platform.rules import local_extractor
from fdre_platform.storage import LocalStorage

from . import audit, tenders
from .context import Actor
from .tenders import NotFound, ValidationFailed

ENGINE_KINDS = {"original": "original", "corrigendum": "corrigendum", "amendment": "amendment", "clarification": "clarification", "ppa": "original", "other": "clarification"}
ENGINE_ROLES = {"original": "rfs", "corrigendum": "amendment", "amendment": "amendment", "clarification": "clarification", "ppa": "ppa", "other": "rfs"}


class DuplicateDocument(Exception):
    def __init__(self, document: TenderDocument) -> None:
        super().__init__(f"document already stored as {document.filename} (publication order {document.publication_order})")
        self.document = document


def _dump(d: TenderDocument) -> dict[str, Any]:
    return {
        "filename": d.filename, "sha256": d.sha256, "kind": d.kind, "role": d.role, "publication_order": d.publication_order,
        "issued_on": d.issued_on.isoformat() if d.issued_on else None, "effective_on": d.effective_on.isoformat() if d.effective_on else None,
        "supersedes_document_id": d.supersedes_document_id, "source_url": d.source_url, "status": d.status, "engine_version_no": d.engine_version_no,
    }


def upload(
    session: Session, settings: Settings, storage: LocalStorage, engine: TenderEngine, actor: Actor, tender_id: str, *,
    filename: str, data: bytes, kind: str = "original", issued_on: date | None = None, effective_on: date | None = None,
    supersedes_document_id: str | None = None, source_url: str | None = None, summary_of_change: str | None = None, content_type: str = "application/pdf",
) -> TenderDocument:
    actor.require("tender.edit")
    tender = tenders.get(session, actor, tender_id)
    if kind not in DOCUMENT_KINDS:
        raise ValidationFailed(f"unknown document kind {kind}")
    if not data:
        raise ValidationFailed("empty file")
    digest = hashlib.sha256(data).hexdigest()
    existing = session.scalar(select(TenderDocument).where(TenderDocument.tender_id == tender.id, TenderDocument.sha256 == digest))
    if existing is not None:
        raise DuplicateDocument(existing)
    if supersedes_document_id:
        prev = session.get(TenderDocument, supersedes_document_id)
        if prev is None or prev.tender_id != tender.id:
            raise ValidationFailed("superseded document is not in this tender")
    order = (session.scalar(select(func.max(TenderDocument.publication_order)).where(TenderDocument.tender_id == tender.id)) or 0) + 1
    stored = storage.put(actor.organization_id, f"tenders/{tender.id}/documents", filename, data)
    doc = TenderDocument(
        organization_id=actor.organization_id, tender_id=tender.id, filename=filename, sha256=digest, size_bytes=len(data), content_type=content_type,
        storage_key=stored.key, kind=kind, role=ENGINE_ROLES[kind], publication_order=order, issued_on=issued_on, effective_on=effective_on or issued_on,
        supersedes_document_id=supersedes_document_id, source_url=source_url, created_by=actor.user_id,
    )
    session.add(doc)
    session.flush()
    # Push to tender_engine (live or fixture). The platform record exists even if this fails.
    try:
        if tender.engine_tender_id is None:
            created = engine.create_tender(tender_type=_engine_type(tender), agency=tender.procurer or "unknown", title=tender.name, external_ref=tender.attributes.get("engine_fixture") and f"fixture:{tender.attributes['engine_fixture']}" or tender.reference)
            tender.engine_tender_id = created.id
            tender.attributes = {**tender.attributes, "engine_source": created.source}
        version = engine.add_version(tender.engine_tender_id, filename=filename, data=data, kind=ENGINE_KINDS[kind], issued_on=issued_on, role=ENGINE_ROLES[kind], summary_of_change=summary_of_change)
        doc.engine_tender_id = tender.engine_tender_id
        doc.engine_version_no = version.version_no
        doc.engine_document_id = version.document_ids[0] if version.document_ids else None
        doc.status = "uploaded"
    except TenderEngineError as exc:
        doc.error = f"tender_engine: {exc}"
    session.flush()
    audit.record(session, actor, "document.upload", "tender_document", doc.id, after=_dump(doc), tender_id=tender.id)
    _record_chain(session, actor, tender)
    return doc


def _engine_type(tender: Tender) -> str:
    return {"fdre": "fdre", "re_rtc": "re_rtc", "solar": "solar", "wind": "wind", "hybrid": "hybrid", "bess": "bess", "cfd": "fdre", "other": "generation"}.get(tender.tender_family, "fdre")


def _record_chain(session: Session, actor: Actor, tender: Tender) -> None:
    """Keep the document chain on the tender so run snapshots can carry it."""
    docs = list_documents(session, actor, tender.id)
    tender.attributes = {
        **tender.attributes,
        "document_versions": [{"document_id": d.id, "sha256": d.sha256, "kind": d.kind, "order": d.publication_order, "issued_on": d.issued_on.isoformat() if d.issued_on else None} for d in docs],
        "amendment_chain": [{"document_id": d.id, "supersedes": d.supersedes_document_id, "effective_on": d.effective_on.isoformat() if d.effective_on else None} for d in docs if d.kind != "original"],
    }
    session.flush()


def list_documents(session: Session, actor: Actor, tender_id: str) -> list[TenderDocument]:
    tender = tenders.get(session, actor, tender_id)
    return list(session.scalars(select(TenderDocument).where(TenderDocument.tender_id == tender.id).order_by(TenderDocument.publication_order)))


def get(session: Session, actor: Actor, document_id: str) -> TenderDocument:
    doc = session.get(TenderDocument, document_id)
    if doc is None or doc.organization_id != actor.organization_id:
        raise NotFound("document")
    tenders.get(session, actor, doc.tender_id)
    return doc


def extract_candidates(session: Session, settings: Settings, storage: LocalStorage, engine: TenderEngine, actor: Actor, document_id: str, *, extractor: str = "auto") -> tuple[list[Candidate], str]:
    """Candidates for one document. `auto`: tender_engine's decided view or its live
    candidates when the engine holds any for this document, else the local extractor.
    Returns the candidates and the name of what produced them."""
    doc = get(session, actor, document_id)
    tender = tenders.get(session, actor, doc.tender_id)
    if extractor in ("auto", "tender_engine") and tender.engine_tender_id and doc.engine_version_no:
        try:
            document_map = {d.engine_document_id: d.id for d in list_documents(session, actor, tender.id) if d.engine_document_id}
            view = engine.view(tender.engine_tender_id)
            src = view.get("source", engine.source)
            cands = [c for c in candidates_from_view(view, document_map=document_map, source=src) if (c.evidence or {}).get("document_version") in (doc.engine_version_no, None)]
            if not cands:
                state = engine.review_state(tender.engine_tender_id, doc.engine_version_no)
                cands = candidates_from_review_state(state, document_map=document_map, source=state.get("source", engine.source))
            if cands:
                doc.extractor = f"tender_engine:{src}"
                doc.status = "extracted"
                session.flush()
                return cands, doc.extractor
        except TenderEngineError as exc:
            doc.error = f"tender_engine: {exc}"
            session.flush()
        if extractor == "tender_engine":
            return [], "tender_engine"
    data = storage.get_for(actor.organization_id, doc.storage_key)
    pages = local_extractor.page_texts(doc.filename, data)
    doc.page_count = len(pages)
    cands = local_extractor.extract(pages, document_id=doc.id)
    doc.extractor = local_extractor.EXTRACTOR
    doc.status = "extracted"
    session.flush()
    return cands, local_extractor.EXTRACTOR
