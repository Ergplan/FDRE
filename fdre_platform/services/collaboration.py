"""Tender chat, threaded comments, mentions and review decisions. Comments are immutable
(database trigger): a correction is a new comment pointing at the old one; deletion is a
flag with the actor. Mentions notify; every post is audited."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from fdre_platform.models import Comment, User

from . import audit, notifications, tenders
from .context import Actor
from .tenders import NotFound, ValidationFailed

MENTION = re.compile(r"@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})")
DECISIONS = ("approved", "rejected", "changes_requested")


def _dump(c: Comment) -> dict[str, Any]:
    return {
        "id": c.id, "tender_id": c.tender_id, "kind": c.kind, "object_type": c.object_type, "object_id": c.object_id, "parent_id": c.parent_id, "body": c.body if c.deleted_at is None else "", "mentions": c.mentions,
        "decision": c.decision, "deleted_at": c.deleted_at, "deleted_by": c.deleted_by, "corrects_comment_id": c.corrects_comment_id, "created_at": c.created_at, "created_by": c.created_by, "deleted": c.deleted_at is not None,
    }


def post(session: Session, actor: Actor, tender_id: str, *, body: str, kind: str = "chat", object_type: str | None = None, object_id: str | None = None, parent_id: str | None = None, decision: str | None = None, corrects_comment_id: str | None = None) -> Comment:
    actor.require("comment.write")
    tender = tenders.get(session, actor, tender_id)
    body = body.strip()
    if not body:
        raise ValidationFailed("empty comment")
    if kind not in ("chat", "comment", "decision"):
        raise ValidationFailed("kind must be chat, comment or decision")
    if kind == "decision":
        if decision not in DECISIONS:
            raise ValidationFailed(f"decision must be one of {DECISIONS}")
        actor.require("bid.approve" if decision == "approved" else "finance.review") if not actor.can("bid.approve") and not actor.can("finance.review") else None
    if parent_id:
        parent = session.get(Comment, parent_id)
        if parent is None or parent.tender_id != tender.id:
            raise ValidationFailed("parent comment is not in this tender")
    emails = {m.lower() for m in MENTION.findall(body)}
    mentioned = list(session.scalars(select(User).where(User.email.in_(emails)))) if emails else []
    member_ids = {u.id for _, u in tenders.members(session, actor, tender.id)}
    mentioned_ids = [u.id for u in mentioned if u.id in member_ids]
    c = Comment(organization_id=actor.organization_id, tender_id=tender.id, kind=kind, object_type=object_type, object_id=object_id, parent_id=parent_id, body=body, mentions=mentioned_ids, decision=decision, corrects_comment_id=corrects_comment_id, created_by=actor.user_id)
    session.add(c)
    session.flush()
    audit.record(session, actor, f"comment.{kind}", "comment", c.id, after={"object_type": object_type, "object_id": object_id, "parent_id": parent_id, "mentions": mentioned_ids, "decision": decision, "body": body[:500]}, tender_id=tender.id)
    if mentioned_ids:
        notifications.notify(session, organization_id=actor.organization_id, user_ids=mentioned_ids, kind="mention", title=f"{actor.label} mentioned you in {tender.name}", body=body[:300], link=f"/tenders/{tender.id}/comments/{c.id}", dedupe_key=f"mention:{c.id}", object_type="comment", object_id=c.id, created_by=actor.user_id)
    if parent_id:
        parent = session.get(Comment, parent_id)
        if parent is not None and parent.created_by and parent.created_by != actor.user_id:
            notifications.notify(session, organization_id=actor.organization_id, user_ids=[parent.created_by], kind="reply", title=f"{actor.label} replied in {tender.name}", body=body[:300], link=f"/tenders/{tender.id}/comments/{c.id}", dedupe_key=f"reply:{c.id}", object_type="comment", object_id=c.id, created_by=actor.user_id)
    if kind == "decision":
        notifications.notify(session, organization_id=actor.organization_id, user_ids=[uid for uid in member_ids if uid != actor.user_id], kind="decision", title=f"{actor.label} recorded a decision on {tender.name}: {decision}", body=body[:300], link=f"/tenders/{tender.id}/comments/{c.id}", dedupe_key=f"decision:{c.id}", object_type=object_type, object_id=object_id, created_by=actor.user_id)
    return c


def list_comments(session: Session, actor: Actor, tender_id: str, *, kind: str | None = None, object_type: str | None = None, object_id: str | None = None, since: datetime | None = None, limit: int = 200) -> list[dict[str, Any]]:
    tender = tenders.get(session, actor, tender_id)
    stmt = select(Comment).where(Comment.tender_id == tender.id)
    if kind:
        stmt = stmt.where(Comment.kind == kind)
    if object_type:
        stmt = stmt.where(Comment.object_type == object_type)
    if object_id:
        stmt = stmt.where(Comment.object_id == object_id)
    if since:
        stmt = stmt.where(Comment.created_at > since)
    rows = list(session.scalars(stmt.order_by(Comment.created_at.asc()).limit(limit)))
    users = {u.id: u.email for u in session.scalars(select(User).where(User.id.in_({r.created_by for r in rows if r.created_by})))} if rows else {}
    return [{**_dump(r), "author": users.get(r.created_by)} for r in rows]


def delete(session: Session, actor: Actor, comment_id: str) -> Comment:
    c = session.get(Comment, comment_id)
    if c is None or c.organization_id != actor.organization_id:
        raise NotFound("comment")
    tenders.get(session, actor, c.tender_id)
    if c.created_by != actor.user_id and not actor.can("members.manage"):
        raise ValidationFailed("only the author or a manager can delete a comment")
    if c.deleted_at is None:
        c.deleted_at = datetime.now(UTC)
        c.deleted_by = actor.user_id
        session.flush()
        audit.record(session, actor, "comment.delete", "comment", c.id, before={"body": c.body[:500]}, after={"deleted": True}, tender_id=c.tender_id)
    return c
