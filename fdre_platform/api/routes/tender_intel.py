"""Documents, requirements, rules, amendments, tasks and timeline of a tender."""

from __future__ import annotations

from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field

from fdre_platform.api.deps import ActorDep, SessionDep, SettingsDep, StorageDep
from fdre_platform.integrations.tender_engine import Candidate, TenderEngine
from fdre_platform.models import RuleSetVersion
from fdre_platform.rules.catalog import FIELDS
from fdre_platform.services import amendments, documents, requirements, summary, tenders
from sqlalchemy import select

router = APIRouter(prefix="/orgs/{org_id}", tags=["tender intelligence"])


def get_engine(request: Request) -> TenderEngine:
    return request.app.state.tender_engine  # type: ignore[no-any-return]


def _doc(d) -> dict[str, Any]:
    return {
        "id": d.id, "tender_id": d.tender_id, "filename": d.filename, "sha256": d.sha256, "size_bytes": d.size_bytes, "kind": d.kind, "role": d.role,
        "publication_order": d.publication_order, "issued_on": d.issued_on, "effective_on": d.effective_on, "supersedes_document_id": d.supersedes_document_id,
        "source_url": d.source_url, "page_count": d.page_count, "status": d.status, "extractor": d.extractor, "engine_version_no": d.engine_version_no,
        "engine_source": "fixture" if (d.extractor or "").endswith("fixture") else None, "error": d.error, "created_at": d.created_at, "created_by": d.created_by,
    }


def _version(session, v, include_rows: bool = True) -> dict[str, Any]:
    out = {
        "id": v.id, "tender_id": v.tender_id, "version_no": v.version_no, "status": v.status, "based_on_document_id": v.based_on_document_id,
        "previous_version_id": v.previous_version_id, "created_from": v.created_from, "note": v.note, "locked_at": v.locked_at, "approved_by": v.approved_by,
        "approved_at": v.approved_at, "conflicts": v.conflicts, "created_at": v.created_at, "created_by": v.created_by,
    }
    if include_rows:
        out["requirements"] = [requirements._req_dict(r) for r in requirements.rows_of(session, v)]
        out["rules"] = requirements.compiled(session, v)
    return out


def _impact(i) -> dict[str, Any]:
    return {
        "id": i.id, "tender_id": i.tender_id, "document_id": i.document_id, "from_requirement_version_id": i.from_requirement_version_id,
        "to_requirement_version_id": i.to_requirement_version_id, "changes": i.changes, "affected_scenario_ids": i.affected_scenario_ids,
        "affected_run_ids": i.affected_run_ids, "owner_user_id": i.owner_user_id, "status": i.status, "applied_at": i.applied_at, "summary": i.summary, "created_at": i.created_at,
    }


def _task(t) -> dict[str, Any]:
    return {
        "id": t.id, "tender_id": t.tender_id, "assignee_user_id": t.assignee_user_id, "kind": t.kind, "title": t.title, "body": t.body, "object_type": t.object_type,
        "object_id": t.object_id, "status": t.status, "due_on": t.due_on, "created_at": t.created_at, "created_by": t.created_by, "completed_by": t.completed_by, "completed_at": t.completed_at,
    }


class CandidateIn(BaseModel):
    field_path: str
    value: Any
    provenance: str = "user_entered"
    confidence: float | None = None
    evidence: dict[str, Any] | None = None
    unit: str | None = None
    effective_date: date | None = None


class ManualRequirementsIn(BaseModel):
    candidates: list[CandidateIn]
    note: str = ""


class ReviewIn(BaseModel):
    decision: str
    value: Any = None
    note: str = ""
    evidence: dict[str, Any] | None = None


class TaskStatusIn(BaseModel):
    status: str = "done"


class IngestOut(BaseModel):
    document: dict[str, Any]
    requirement_version: dict[str, Any] | None
    changes: list[dict[str, Any]] = Field(default_factory=list)
    impact: dict[str, Any] | None
    extractor: str | None


@router.get("/requirement-catalog")
def catalog(actor: ActorDep) -> list[dict[str, Any]]:
    """Shared reference data, still served only to members of the organisation in the path."""
    return [f.__dict__ | {"enum": list(f.enum)} for f in FIELDS]


@router.post("/tenders/{tender_id}/documents", response_model=IngestOut, status_code=201)
async def upload_document(
    tender_id: str, request: Request, file: UploadFile, session: SessionDep, settings: SettingsDep, storage: StorageDep, actor: ActorDep,
    kind: Annotated[str, Form()] = "original", issued_on: Annotated[date | None, Form()] = None, effective_on: Annotated[date | None, Form()] = None,
    supersedes_document_id: Annotated[str | None, Form()] = None, source_url: Annotated[str | None, Form()] = None, summary_of_change: Annotated[str | None, Form()] = None,
    extract: Annotated[bool, Form()] = True, extractor: Annotated[str, Form()] = "auto", candidates_json: Annotated[str | None, Form()] = None,
) -> IngestOut:
    data = await file.read()
    engine = get_engine(request)
    cands = None
    if candidates_json:
        import json

        cands = [Candidate(**{**c, "source": "user", "extractor": c.get("extractor", "supplied")}) for c in json.loads(candidates_json)]
    result = amendments.ingest(
        session, settings, storage, engine, actor, tender_id, filename=file.filename or "document.pdf", data=data, kind=kind, issued_on=issued_on, effective_on=effective_on,
        supersedes_document_id=supersedes_document_id, source_url=source_url, summary_of_change=summary_of_change, extract=extract, extractor=extractor, candidates=cands,
    )
    session.commit()
    return IngestOut(
        document=_doc(result["document"]), requirement_version=_version(session, result["requirement_version"], include_rows=False) if result["requirement_version"] else None,
        changes=result["changes"], impact=_impact(result["impact"]) if result["impact"] else None, extractor=result["extractor"],
    )


@router.get("/tenders/{tender_id}/documents")
def list_documents(tender_id: str, session: SessionDep, actor: ActorDep) -> list[dict[str, Any]]:
    return [_doc(d) for d in documents.list_documents(session, actor, tender_id)]


@router.get("/documents/{document_id}/file")
def document_file(document_id: str, session: SessionDep, actor: ActorDep, storage: StorageDep) -> Response:
    doc = documents.get(session, actor, document_id)
    return Response(content=storage.get_for(actor.organization_id, doc.storage_key), media_type=doc.content_type, headers={"Content-Disposition": f'inline; filename="{doc.filename}"', "X-Content-SHA256": doc.sha256})


@router.get("/tenders/{tender_id}/requirements")
def current_requirements(tender_id: str, session: SessionDep, actor: ActorDep, version_id: str | None = None) -> dict[str, Any]:
    tender = tenders.get(session, actor, tender_id)
    version = requirements.get_version(session, actor, version_id) if version_id else requirements.current_version(session, tender)
    if version is None:
        return {"tender_id": tender.id, "version": None, "approved": None, "summary": None}
    approved = requirements.current_version(session, tender, approved_only=True)
    return {"tender_id": tender.id, "version": _version(session, version), "approved": _version(session, approved, include_rows=False) if approved else None, "summary": summary.build(session, version)}


@router.get("/tenders/{tender_id}/requirements/versions")
def requirement_versions(tender_id: str, session: SessionDep, actor: ActorDep) -> list[dict[str, Any]]:
    return [_version(session, v, include_rows=False) for v in requirements.versions_for(session, actor, tender_id)]


@router.get("/requirement-versions/{version_id}")
def requirement_version(version_id: str, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    return _version(session, requirements.get_version(session, actor, version_id))


@router.post("/tenders/{tender_id}/requirements/manual", status_code=201)
def manual_requirements(tender_id: str, body: ManualRequirementsIn, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    cands = [Candidate(field_path=c.field_path, value=c.value, provenance=c.provenance if c.provenance in ("user_entered", "defaulted", "inferred") else "user_entered", confidence=c.confidence, evidence=c.evidence, unit=c.unit, effective_date=c.effective_date, extractor="user", source="user") for c in body.candidates]
    version, changes = requirements.create_version(session, actor, tender_id, cands, document=None, created_from="manual", note=body.note)
    session.commit()
    return {"version": _version(session, version), "changes": changes}


@router.post("/requirements/{requirement_id}/review")
def review_requirement(requirement_id: str, body: ReviewIn, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    row = requirements.review(session, actor, requirement_id, decision=body.decision, value=body.value, note=body.note, evidence=body.evidence)
    session.commit()
    return requirements._req_dict(row)


@router.post("/requirement-versions/{version_id}/approve")
def approve_version(version_id: str, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    version, rule_set = requirements.approve(session, actor, version_id)
    applied = amendments.apply_approved(session, actor, version)
    session.commit()
    return {"version": _version(session, version, include_rows=False), "rule_set": _rule_set(rule_set), "applied": applied}


@router.post("/requirement-versions/{version_id}/discard")
def discard_version(version_id: str, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    version = requirements.discard(session, actor, version_id)
    session.commit()
    return _version(session, version, include_rows=False)


def _rule_set(r: RuleSetVersion) -> dict[str, Any]:
    return {"id": r.id, "tender_id": r.tender_id, "requirement_version_id": r.requirement_version_id, "version_no": r.version_no, "status": r.status, "rules": r.rules, "unsupported_count": r.unsupported_count, "certifiable": r.certifiable, "blocking": r.blocking, "compiler_version": r.compiler_version, "approved_by": r.approved_by, "approved_at": r.approved_at}


@router.get("/tenders/{tender_id}/rules")
def rule_sets(tender_id: str, session: SessionDep, actor: ActorDep) -> list[dict[str, Any]]:
    tender = tenders.get(session, actor, tender_id)
    return [_rule_set(r) for r in session.scalars(select(RuleSetVersion).where(RuleSetVersion.tender_id == tender.id).order_by(RuleSetVersion.version_no.desc()))]


@router.get("/tenders/{tender_id}/summary")
def tender_summary(tender_id: str, session: SessionDep, actor: ActorDep) -> dict[str, Any] | None:
    tender = tenders.get(session, actor, tender_id)
    version = requirements.current_version(session, tender)
    return summary.build(session, version) if version else None


@router.get("/tenders/{tender_id}/amendments")
def list_impacts(tender_id: str, session: SessionDep, actor: ActorDep) -> list[dict[str, Any]]:
    return [_impact(i) for i in amendments.impacts_for(session, actor, tender_id)]


@router.get("/tenders/{tender_id}/timeline")
def tender_timeline(tender_id: str, session: SessionDep, actor: ActorDep) -> list[dict[str, Any]]:
    return amendments.timeline(session, actor, tender_id)


@router.get("/tasks")
def list_tasks(session: SessionDep, actor: ActorDep, tender_id: str | None = None, mine: bool = False, status: str | None = "open") -> list[dict[str, Any]]:
    return [_task(t) for t in amendments.tasks_for(session, actor, tender_id=tender_id, mine=mine, status=status)]


@router.post("/tasks/{task_id}/complete")
def complete_task(task_id: str, body: TaskStatusIn, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    task = amendments.complete_task(session, actor, task_id, status=body.status)
    session.commit()
    return _task(task)


@router.get("/tender-engine/health")
def engine_health(request: Request, actor: ActorDep) -> dict[str, Any]:
    engine = get_engine(request)
    try:
        return {"source": engine.source, **engine.health()}
    except Exception as exc:  # noqa: BLE001
        return {"source": engine.source, "status": "unreachable", "error": str(exc)[:300]}
