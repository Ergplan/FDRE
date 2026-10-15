"""Collaboration (chat, comments, decisions), historical tender results and the workbook export."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from fdre_platform.api.deps import ActorDep, SessionDep, StorageDep
from fdre_platform.models import RunArtifact
from fdre_platform.services import collaboration, history, runs

router = APIRouter(prefix="/orgs/{org_id}", tags=["collaboration and history"])


class CommentIn(BaseModel):
    body: str
    kind: str = "chat"
    object_type: str | None = None
    object_id: str | None = None
    parent_id: str | None = None
    decision: str | None = None
    corrects_comment_id: str | None = None


@router.get("/tenders/{tender_id}/comments")
def list_comments(tender_id: str, session: SessionDep, actor: ActorDep, kind: str | None = None, object_type: str | None = None, object_id: str | None = None, since: datetime | None = None) -> list[dict[str, Any]]:
    return collaboration.list_comments(session, actor, tender_id, kind=kind, object_type=object_type, object_id=object_id, since=since)


@router.post("/tenders/{tender_id}/comments", status_code=201)
def post_comment(tender_id: str, body: CommentIn, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    c = collaboration.post(session, actor, tender_id, body=body.body, kind=body.kind, object_type=body.object_type, object_id=body.object_id, parent_id=body.parent_id, decision=body.decision, corrects_comment_id=body.corrects_comment_id)
    session.commit()
    return {**collaboration._dump(c), "author": actor.label}


@router.post("/comments/{comment_id}/delete")
def delete_comment(comment_id: str, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    c = collaboration.delete(session, actor, comment_id)
    session.commit()
    return collaboration._dump(c)


@router.get("/history/awards")
def comparables(session: SessionDep, actor: ActorDep, tender_family: str | None = None, procurer: str | None = None, capacity_mw: float | None = None, storage: bool | None = None, contract_years: int | None = None, since: date | None = None, tariff_only: bool = True, limit: int = 50) -> dict[str, Any]:
    actor.require("tender.read")
    return {"freshness": history.freshness(session), "results": history.comparables(session, tender_family=tender_family, procurer=procurer, capacity_mw=capacity_mw, storage=storage, contract_years=contract_years, since=since, limit=min(limit, 200), tariff_only=tariff_only)}


@router.get("/history/freshness")
def freshness(session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    return history.freshness(session)


class DedupeIn(BaseModel):
    records: list[dict[str, Any]]


@router.post("/history/dedupe-check")
def dedupe_check(body: DedupeIn, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    actor.require("tender.read")
    return history.dedupe_candidates(session, body.records)


@router.post("/runs/{run_id}/workbook", status_code=201)
def export_workbook(run_id: str, session: SessionDep, actor: ActorDep, storage: StorageDep, verify: bool = True) -> dict[str, Any]:
    """Build the formula workbook for a finance-bearing run, store it as an immutable run
    artifact, and (when asked) verify it by recalculation with LibreOffice."""
    from fdre_platform.services import workbook_export

    artifact, verdict = workbook_export.export(session, storage, actor, run_id, verify=verify)
    session.commit()
    return {"artifact": {"id": artifact.id, "kind": artifact.kind, "filename": artifact.filename, "sha256": artifact.sha256, "size_bytes": artifact.size_bytes, "download": f"/api/v1/orgs/{actor.organization_id}/runs/{run_id}/artifacts/{artifact.kind}"}, "verification": verdict}


@router.get("/runs/{run_id}/artifacts")
def list_artifacts(run_id: str, session: SessionDep, actor: ActorDep) -> list[dict[str, Any]]:
    from sqlalchemy import select

    run = runs.get(session, actor, run_id)
    return [{"id": a.id, "kind": a.kind, "filename": a.filename, "sha256": a.sha256, "size_bytes": a.size_bytes, "created_at": a.created_at} for a in session.scalars(select(RunArtifact).where(RunArtifact.run_id == run.id))]


def _unused(_: Response, __: HTTPException) -> None:
    return None
