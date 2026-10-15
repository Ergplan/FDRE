from __future__ import annotations

from fastapi import APIRouter, HTTPException

from fdre_platform.api import schemas
from fdre_platform.api.deps import ActorDep, SessionDep
from fdre_platform.services import notifications

router = APIRouter(prefix="/orgs/{org_id}/notifications", tags=["notifications"])


@router.get("", response_model=list[schemas.NotificationOut])
def list_notifications(session: SessionDep, actor: ActorDep, unread_only: bool = False) -> list[schemas.NotificationOut]:
    assert actor.user_id
    return [schemas.NotificationOut.model_validate(n, from_attributes=True) for n in notifications.for_user(session, actor.organization_id, actor.user_id, unread_only)]


@router.post("/{notification_id}/read", response_model=schemas.NotificationOut)
def read_notification(notification_id: str, session: SessionDep, actor: ActorDep) -> schemas.NotificationOut:
    assert actor.user_id
    note = notifications.mark_read(session, actor.organization_id, actor.user_id, notification_id)
    if note is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": "notification not found"})
    session.commit()
    return schemas.NotificationOut.model_validate(note, from_attributes=True)
