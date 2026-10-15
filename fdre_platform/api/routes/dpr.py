"""Post-award: award records, DPR workspaces, versions, trace and exports."""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from fdre_platform.api.deps import ActorDep, SessionDep, StorageDep
from fdre_platform.services import dpr

router = APIRouter(prefix="/orgs/{org_id}", tags=["dpr"])


class AwardIn(BaseModel):
    run_id: str
    tariff_inr_per_kwh: float
    capacity_mw: float
    award_date: date
    letter_reference: str = ""
    note: str = ""


class DprSaveIn(BaseModel):
    expected_revision: int
    sections: list[dict[str, Any]]
    change_note: str = ""


class DprStatusIn(BaseModel):
    expected_revision: int
    status: str


@router.post("/tenders/{tender_id}/awards", status_code=201)
def record_award(tender_id: str, body: AwardIn, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    a = dpr.record_award(
        session,
        actor,
        body.run_id,
        tariff_inr_per_kwh=body.tariff_inr_per_kwh,
        capacity_mw=body.capacity_mw,
        award_date=body.award_date,
        letter_reference=body.letter_reference,
        note=body.note,
    )
    if a.tender_id != tender_id:
        session.rollback()
        raise HTTPException(status_code=422, detail={"error": "validation_failed", "message": "run belongs to another tender"})
    session.commit()
    return dpr.dump_award(a)


@router.get("/tenders/{tender_id}/awards")
def list_awards(tender_id: str, session: SessionDep, actor: ActorDep) -> list[dict[str, Any]]:
    return [dpr.dump_award(a) for a in dpr.list_awards(session, actor, tender_id)]


@router.get("/awards/{award_id}")
def get_award(award_id: str, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    a = dpr.get_award(session, actor, award_id)
    ws = dpr.workspace_for_award(session, actor, award_id)
    return {**dpr.dump_award(a), "dpr_workspace_id": ws.id if ws else None}


@router.post("/awards/{award_id}/dpr", status_code=201)
def create_dpr(award_id: str, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    ws, v = dpr.create_workspace(session, actor, award_id)
    session.commit()
    return dpr.dump_workspace(ws, v)


@router.get("/dpr/{workspace_id}")
def get_dpr(workspace_id: str, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    ws = dpr.get_workspace(session, actor, workspace_id)
    return dpr.dump_workspace(ws, dpr.current_version(session, ws))


@router.get("/dpr/{workspace_id}/versions")
def dpr_versions(workspace_id: str, session: SessionDep, actor: ActorDep) -> list[dict[str, Any]]:
    return [dpr.dump_version(v) for v in dpr.versions(session, actor, workspace_id)]


@router.put("/dpr/{workspace_id}")
def save_dpr(workspace_id: str, body: DprSaveIn, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    v = dpr.save_version(session, actor, workspace_id, expected_revision=body.expected_revision, sections=body.sections, change_note=body.change_note)
    session.commit()
    ws = dpr.get_workspace(session, actor, workspace_id)
    return dpr.dump_workspace(ws, v)


@router.post("/dpr/{workspace_id}/status")
def dpr_status(workspace_id: str, body: DprStatusIn, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    ws = dpr.set_status(session, actor, workspace_id, expected_revision=body.expected_revision, status=body.status)
    session.commit()
    return dpr.dump_workspace(ws, dpr.current_version(session, ws))


@router.get("/dpr/{workspace_id}/trace")
def dpr_trace(workspace_id: str, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    return dpr.trace(session, actor, workspace_id)


@router.post("/dpr/{workspace_id}/export", status_code=201)
def export_dpr(workspace_id: str, session: SessionDep, actor: ActorDep, storage: StorageDep, format: str = "docx") -> dict[str, Any]:
    a = dpr.export(session, storage, actor, workspace_id, format)
    session.commit()
    return {**dpr.dump_artifact(a), "download": f"/api/v1/orgs/{actor.organization_id}/dpr/{workspace_id}/artifacts/{a.id}"}


@router.get("/dpr/{workspace_id}/artifacts")
def dpr_artifacts(workspace_id: str, session: SessionDep, actor: ActorDep) -> list[dict[str, Any]]:
    return [
        {**dpr.dump_artifact(a), "download": f"/api/v1/orgs/{actor.organization_id}/dpr/{workspace_id}/artifacts/{a.id}"}
        for a in dpr.artifacts(session, actor, workspace_id)
    ]


@router.get("/dpr/{workspace_id}/artifacts/{artifact_id}")
def download_dpr_artifact(workspace_id: str, artifact_id: str, session: SessionDep, actor: ActorDep, storage: StorageDep) -> Response:
    art = next((a for a in dpr.artifacts(session, actor, workspace_id) if a.id == artifact_id), None)
    if art is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": "artifact not found"})
    data = storage.get_for(actor.organization_id, art.storage_key)
    return Response(
        content=data, media_type=art.content_type, headers={"Content-Disposition": f'attachment; filename="{art.filename}"', "X-Content-SHA256": art.sha256}
    )
