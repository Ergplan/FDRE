"""Tender records and tender membership. Visibility: an administrator sees every tender of
the organisation; everyone else needs a tender_member row."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from fdre_platform.models import TENDER_FAMILIES, TENDER_STATUSES, Tender, TenderMember, User
from fdre_platform.permissions import ORG_WIDE_TENDER_ACCESS

from . import audit
from .context import Actor


class NotFound(LookupError):
    """Raised for an object the actor may not see. The API answers 404 so existence does
    not leak across organisations."""


class Conflict(Exception):
    def __init__(self, message: str, current_revision: int, conflicts: list[str] | None = None) -> None:
        super().__init__(message)
        self.current_revision = current_revision
        self.conflicts = conflicts or []


class ValidationFailed(ValueError):
    pass


def _dump(t: Tender) -> dict[str, Any]:
    return {
        "name": t.name, "procurer": t.procurer, "tender_family": t.tender_family, "reference": t.reference,
        "status": t.status, "engine_tender_id": t.engine_tender_id, "attributes": t.attributes, "notes": t.notes,
    }


def create(session: Session, actor: Actor, *, name: str, procurer: str = "", tender_family: str = "fdre", reference: str | None = None, attributes: dict[str, Any] | None = None) -> Tender:
    actor.require("tender.create")
    if tender_family not in TENDER_FAMILIES:
        raise ValidationFailed(f"unknown tender family {tender_family}")
    tender = Tender(
        organization_id=actor.organization_id, name=name.strip(), procurer=procurer.strip(), tender_family=tender_family,
        reference=reference, attributes=attributes or {}, created_by=actor.user_id, updated_by=actor.user_id,
    )
    if not tender.name:
        raise ValidationFailed("name is required")
    session.add(tender)
    session.flush()
    if actor.user_id:
        session.add(TenderMember(organization_id=actor.organization_id, tender_id=tender.id, user_id=actor.user_id, created_by=actor.user_id))
        session.flush()
    audit.record(session, actor, "tender.create", "tender", tender.id, object_version=tender.revision, after=_dump(tender))
    return tender


def visible(session: Session, actor: Actor) -> list[Tender]:
    stmt = select(Tender).where(Tender.organization_id == actor.organization_id)
    if actor.role not in ORG_WIDE_TENDER_ACCESS and actor.user_id is not None:
        stmt = stmt.join(TenderMember, TenderMember.tender_id == Tender.id).where(TenderMember.user_id == actor.user_id)
    return list(session.scalars(stmt.order_by(Tender.updated_at.desc())))


def get(session: Session, actor: Actor, tender_id: str) -> Tender:
    actor.require("tender.read")
    tender = session.get(Tender, tender_id)
    if tender is None or tender.organization_id != actor.organization_id:
        raise NotFound("tender")
    if actor.role in ORG_WIDE_TENDER_ACCESS or actor.user_id is None:
        return tender
    member = session.scalar(select(TenderMember).where(TenderMember.tender_id == tender.id, TenderMember.user_id == actor.user_id))
    if member is None:
        raise NotFound("tender")
    return tender


def update(session: Session, actor: Actor, tender_id: str, expected_revision: int, changes: dict[str, Any]) -> Tender:
    actor.require("tender.edit")
    tender = get(session, actor, tender_id)
    if tender.revision != expected_revision:
        raise Conflict("tender changed since you loaded it", tender.revision, sorted(changes))
    before = _dump(tender)
    allowed = {"name", "procurer", "tender_family", "reference", "status", "attributes", "notes", "engine_tender_id"}
    unknown = set(changes) - allowed
    if unknown:
        raise ValidationFailed(f"unknown fields: {sorted(unknown)}")
    if "status" in changes and changes["status"] not in TENDER_STATUSES:
        raise ValidationFailed("unknown status")
    if "tender_family" in changes and changes["tender_family"] not in TENDER_FAMILIES:
        raise ValidationFailed("unknown tender family")
    for key, value in changes.items():
        setattr(tender, key, value)
    tender.revision += 1
    tender.updated_at = datetime.now(UTC)
    tender.updated_by = actor.user_id
    session.flush()
    audit.record(session, actor, "tender.update", "tender", tender.id, object_version=tender.revision, before=before, after=_dump(tender))
    return tender


def add_member(session: Session, actor: Actor, tender_id: str, user: User) -> TenderMember:
    actor.require("members.manage")
    tender = get(session, actor, tender_id)
    from .auth import membership_in  # local import to avoid a cycle

    if membership_in(session, user, actor.organization_id) is None:
        raise ValidationFailed("user is not a member of this organisation")
    existing = session.scalar(select(TenderMember).where(TenderMember.tender_id == tender.id, TenderMember.user_id == user.id))
    if existing:
        return existing
    member = TenderMember(organization_id=actor.organization_id, tender_id=tender.id, user_id=user.id, created_by=actor.user_id)
    session.add(member)
    session.flush()
    audit.record(session, actor, "tender.member.add", "tender", tender.id, object_version=tender.revision, after={"user_id": user.id, "email": user.email})
    return member


def members(session: Session, actor: Actor, tender_id: str) -> list[tuple[TenderMember, User]]:
    tender = get(session, actor, tender_id)
    rows = session.execute(select(TenderMember, User).join(User, User.id == TenderMember.user_id).where(TenderMember.tender_id == tender.id)).all()
    return [(m, u) for m, u in rows]
