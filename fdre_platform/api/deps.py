"""Request dependencies: db session, the authenticated user, the organisation actor and
permission checks. Authorisation happens here and in the services, on the server."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from fdre_platform.config import Settings
from fdre_platform.models import User, UserSession
from fdre_platform.permissions import permissions_for
from fdre_platform.services import auth
from fdre_platform.services.context import Actor
from fdre_platform.storage import LocalStorage

SESSION_COOKIE = "fdre_session"


def get_settings(request: Request) -> Settings:
    return request.app.state.settings  # type: ignore[no-any-return]


def get_storage(request: Request) -> LocalStorage:
    return request.app.state.storage  # type: ignore[no-any-return]


def get_session(request: Request) -> Iterator[Session]:
    with request.app.state.session_factory() as session:
        yield session


def request_id(request: Request) -> str:
    rid = getattr(request.state, "request_id", None)
    if not rid:
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.request_id = rid
    return rid


SessionDep = Annotated[Session, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
StorageDep = Annotated[LocalStorage, Depends(get_storage)]
RequestIdDep = Annotated[str, Depends(request_id)]


def _token(request: Request, authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return request.cookies.get(SESSION_COOKIE)


def current_user(request: Request, session: SessionDep, authorization: Annotated[str | None, Header()] = None) -> tuple[User, UserSession]:
    resolved = auth.resolve_session(session, _token(request, authorization))
    if resolved is None:
        raise HTTPException(status_code=401, detail={"error": "unauthenticated", "message": "sign in required"})
    session.commit()  # last_seen_at
    return resolved


CurrentUserDep = Annotated[tuple[User, UserSession], Depends(current_user)]


def org_actor(org_id: str, session: SessionDep, user_session: CurrentUserDep, rid: RequestIdDep) -> Actor:
    user, _ = user_session
    membership = auth.membership_in(session, user, org_id)
    if membership is None:
        # 404, not 403: the organisation's existence is not disclosed to non-members.
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": "organisation not found"})
    return Actor(user_id=user.id, label=user.email, organization_id=org_id, role=membership.role, request_id=rid)


ActorDep = Annotated[Actor, Depends(org_actor)]


def require(permission: str):
    def check(actor: ActorDep) -> Actor:
        if permission not in permissions_for(actor.role):
            raise HTTPException(status_code=403, detail={"error": "forbidden", "message": f"permission {permission} required"})
        return actor

    return Depends(check)
