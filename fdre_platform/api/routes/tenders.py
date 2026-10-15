from __future__ import annotations

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from fdre_platform.api import schemas
from fdre_platform.api.deps import ActorDep, SessionDep
from fdre_platform.models import User
from fdre_platform.services import runs, tenders

router = APIRouter(prefix="/orgs/{org_id}/tenders", tags=["tenders"])


def _out(t) -> schemas.TenderOut:
    return schemas.TenderOut.model_validate(t, from_attributes=True)


@router.get("", response_model=list[schemas.TenderOut])
def list_tenders(session: SessionDep, actor: ActorDep) -> list[schemas.TenderOut]:
    actor.require("tender.read")
    return [_out(t) for t in tenders.visible(session, actor)]


@router.post("", response_model=schemas.TenderOut, status_code=201)
def create_tender(body: schemas.TenderIn, session: SessionDep, actor: ActorDep) -> schemas.TenderOut:
    tender = tenders.create(session, actor, name=body.name, procurer=body.procurer, tender_family=body.tender_family, reference=body.reference, attributes=body.attributes)
    session.commit()
    return _out(tender)


@router.get("/{tender_id}", response_model=schemas.TenderOut)
def get_tender(tender_id: str, session: SessionDep, actor: ActorDep) -> schemas.TenderOut:
    return _out(tenders.get(session, actor, tender_id))


@router.patch("/{tender_id}", response_model=schemas.TenderOut)
def patch_tender(tender_id: str, body: schemas.TenderPatchIn, session: SessionDep, actor: ActorDep) -> schemas.TenderOut:
    tender = tenders.update(session, actor, tender_id, body.expected_revision, body.changes)
    session.commit()
    return _out(tender)


@router.get("/{tender_id}/members", response_model=list[schemas.MemberOut])
def tender_members(tender_id: str, session: SessionDep, actor: ActorDep) -> list[schemas.MemberOut]:
    from fdre_platform.services.auth import membership_in

    out = []
    for _, user in tenders.members(session, actor, tender_id):
        m = membership_in(session, user, actor.organization_id)
        out.append(schemas.MemberOut(user_id=user.id, email=user.email, display_name=user.display_name, role=m.role if m else "none"))
    return out


@router.post("/{tender_id}/members", response_model=list[schemas.MemberOut], status_code=201)
def add_tender_member(tender_id: str, body: schemas.TenderMemberIn, session: SessionDep, actor: ActorDep) -> list[schemas.MemberOut]:
    user = None
    if body.user_id:
        user = session.get(User, body.user_id)
    elif body.email:
        user = session.scalar(select(User).where(User.email == body.email.strip().lower()))
    if user is None:
        raise HTTPException(status_code=422, detail={"error": "validation_failed", "message": "user not found"})
    tenders.add_member(session, actor, tender_id, user)
    session.commit()
    return tender_members(tender_id, session, actor)


@router.get("/{tender_id}/runs", response_model=list[schemas.RunOut])
def tender_runs(tender_id: str, session: SessionDep, actor: ActorDep) -> list[schemas.RunOut]:
    from .runs import run_out

    return [run_out(session, r, include_result=False) for r in runs.list_for_tender(session, actor, tender_id)]
