from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import select

from fdre_platform.api import schemas
from fdre_platform.api.deps import ActorDep, SessionDep, require
from fdre_platform.models import Membership, User
from fdre_platform.services import audit, auth
from fdre_platform.services.context import Actor

router = APIRouter(prefix="/orgs/{org_id}", tags=["organisations"])


@router.get("/members", response_model=list[schemas.MemberOut])
def members(session: SessionDep, actor: ActorDep) -> list[schemas.MemberOut]:
    rows = session.execute(select(Membership, User).join(User, User.id == Membership.user_id).where(Membership.organization_id == actor.organization_id)).all()
    return [schemas.MemberOut(user_id=u.id, email=u.email, display_name=u.display_name, role=m.role) for m, u in rows]


@router.post("/users", response_model=schemas.MemberOut, status_code=201)
def create_user(body: schemas.UserCreateIn, session: SessionDep, actor: Actor = require("members.manage")) -> schemas.MemberOut:
    user = session.scalar(select(User).where(User.email == body.email.strip().lower())) or auth.create_user(session, body.email, body.display_name, body.password, actor=actor)
    membership = auth.add_membership(session, actor, user, body.role)
    session.commit()
    return schemas.MemberOut(user_id=user.id, email=user.email, display_name=user.display_name, role=membership.role)


@router.get("/audit", response_model=list[schemas.AuditOut])
def audit_events(session: SessionDep, object_type: str | None = None, object_id: str | None = None, limit: int = 200, actor: Actor = require("audit.read")) -> list[schemas.AuditOut]:
    return [schemas.AuditOut.model_validate(e, from_attributes=True) for e in audit.events_for(session, actor.organization_id, object_type, object_id, min(limit, 1000))]
