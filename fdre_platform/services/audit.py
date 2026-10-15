"""One audit_event per persisted business mutation, in the same transaction."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from fdre_platform.models import AuditEvent

from .context import Actor

SECRET_KEYS = {"password", "password_hash", "token", "secret", "api_key", "authorization"}


def scrub(value: Any) -> Any:
    """Never log credentials or secrets, whatever object carries them."""
    if isinstance(value, dict):
        return {k: ("***" if k.lower() in SECRET_KEYS else scrub(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value


def record(
    session: Session,
    actor: Actor,
    action: str,
    object_type: str,
    object_id: str,
    *,
    object_version: int | None = None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    tender_id: str | None = None,
) -> AuditEvent:
    event = AuditEvent(
        organization_id=actor.organization_id,
        created_by=actor.user_id,
        actor_user_id=actor.user_id,
        actor_label=actor.label,
        action=action,
        object_type=object_type,
        object_id=object_id,
        object_version=object_version,
        before=scrub(before) if before is not None else None,
        after=scrub(after) if after is not None else None,
        request_id=actor.request_id,
        tender_id=tender_id,
    )
    session.add(event)
    session.flush()
    return event


def events_for(session: Session, organization_id: str, object_type: str | None = None, object_id: str | None = None, limit: int = 200) -> list[AuditEvent]:
    stmt = select(AuditEvent).where(AuditEvent.organization_id == organization_id)
    if object_type:
        stmt = stmt.where(AuditEvent.object_type == object_type)
    if object_id:
        stmt = stmt.where(AuditEvent.object_id == object_id)
    return list(session.scalars(stmt.order_by(AuditEvent.at.desc(), AuditEvent.id.desc()).limit(limit)))


def events_for_tender(session: Session, organization_id: str, tender_id: str, limit: int = 200) -> list[AuditEvent]:
    stmt = select(AuditEvent).where(AuditEvent.organization_id == organization_id, AuditEvent.tender_id == tender_id)
    return list(session.scalars(stmt.order_by(AuditEvent.at.desc(), AuditEvent.id.desc()).limit(limit)))
