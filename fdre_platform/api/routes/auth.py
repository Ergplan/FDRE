from __future__ import annotations

from fastapi import APIRouter, Response

from fdre_platform.api import schemas
from fdre_platform.api.deps import SESSION_COOKIE, CurrentUserDep, SessionDep, SettingsDep
from fdre_platform.permissions import permissions_for
from fdre_platform.services import auth

router = APIRouter(prefix="/auth", tags=["auth"])


def _me(session: SessionDep, user) -> schemas.MeOut:
    orgs = [
        schemas.OrgOut(id=o.id, slug=o.slug, name=o.name, role=m.role, permissions=sorted(permissions_for(m.role)))
        for m, o in auth.memberships_of(session, user)
    ]
    return schemas.MeOut(user_id=user.id, email=user.email, display_name=user.display_name, organizations=orgs)


@router.post("/login", response_model=schemas.LoginOut)
def login(body: schemas.LoginIn, session: SessionDep, settings: SettingsDep, response: Response) -> schemas.LoginOut:
    user, sess = auth.login(session, body.email, body.password, settings.session_ttl_hours)
    session.commit()
    response.set_cookie(SESSION_COOKIE, sess.id, httponly=True, samesite="lax", secure=settings.secure_cookies, max_age=settings.session_ttl_hours * 3600, path="/")
    return schemas.LoginOut(token=sess.id, me=_me(session, user))


@router.post("/logout", status_code=204)
def logout(session: SessionDep, user_session: CurrentUserDep, response: Response) -> Response:
    _, sess = user_session
    auth.logout(session, sess)
    session.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    return Response(status_code=204)


@router.get("/me", response_model=schemas.MeOut)
def me(session: SessionDep, user_session: CurrentUserDep) -> schemas.MeOut:
    user, _ = user_session
    return _me(session, user)
