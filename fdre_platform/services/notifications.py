"""Notifications: deduplicated per (org, user, key), unread state, delivery attempts.
Delivery in phase 1 is in-app (the row itself); the delivery fields exist so an email or
webhook channel retries without duplicating."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from fdre_platform.models import Notification


def notify(session: Session, *, organization_id: str, user_ids: list[str], kind: str, title: str, body: str = "", link: str | None = None, dedupe_key: str, object_type: str | None = None, object_id: str | None = None, created_by: str | None = None) -> int:
    """Insert one notification per user; a repeated (user, dedupe_key) is ignored."""
    count = 0
    for user_id in dict.fromkeys(user_ids):
        stmt = insert(Notification).values(
            organization_id=organization_id, user_id=user_id, kind=kind, title=title, body=body, link=link,
            dedupe_key=dedupe_key, object_type=object_type, object_id=object_id, created_by=created_by,
            delivered_at=datetime.now(UTC), delivery_attempts=1,
        ).on_conflict_do_nothing(constraint="uq_notification_dedupe").returning(Notification.id)
        count += len(session.execute(stmt).all())
    return count


def for_user(session: Session, organization_id: str, user_id: str, unread_only: bool = False, limit: int = 100) -> list[Notification]:
    stmt = select(Notification).where(Notification.organization_id == organization_id, Notification.user_id == user_id)
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))
    return list(session.scalars(stmt.order_by(Notification.created_at.desc()).limit(limit)))


def mark_read(session: Session, organization_id: str, user_id: str, notification_id: str) -> Notification | None:
    note = session.get(Notification, notification_id)
    if note is None or note.organization_id != organization_id or note.user_id != user_id:
        return None
    if note.read_at is None:
        note.read_at = datetime.now(UTC)
    return note
