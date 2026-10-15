"""Passwords, sessions and memberships."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta

import bcrypt
from sqlalchemy import select
from sqlalchemy.orm import Session

from fdre_platform.models import Membership, Organization, User, UserSession
from fdre_platform.permissions import ROLES

from . import audit
from .context import Actor, system_actor


class AuthError(Exception):
    pass


def hash_password(password: str) -> str:
    if len(password) < 8:
        raise AuthError("password must be at least 8 characters")
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), password_hash.encode())
    except ValueError:
        return False


def create_organization(session: Session, slug: str, name: str, *, actor: Actor | None = None) -> Organization:
    org = Organization(slug=slug, name=name, created_by=actor.user_id if actor else None)
    session.add(org)
    session.flush()
    audit.record(session, actor or system_actor(org.id, "bootstrap"), "organization.create", "organization", org.id, after={"slug": slug, "name": name})
    return org


def create_user(session: Session, email: str, display_name: str, password: str, *, actor: Actor | None = None) -> User:
    email = email.strip().lower()
    if session.scalar(select(User).where(User.email == email)):
        raise AuthError("a user with this email exists")
    user = User(email=email, display_name=display_name, password_hash=hash_password(password), created_by=actor.user_id if actor else None)
    session.add(user)
    session.flush()
    return user


def add_membership(session: Session, actor: Actor, user: User, role: str) -> Membership:
    if role not in ROLES:
        raise AuthError(f"unknown role {role}")
    existing = session.scalar(select(Membership).where(Membership.organization_id == actor.organization_id, Membership.user_id == user.id))
    if existing:
        before = {"role": existing.role}
        existing.role = role
        session.flush()
        audit.record(session, actor, "membership.update", "membership", existing.id, before=before, after={"role": role, "user_id": user.id})
        return existing
    membership = Membership(organization_id=actor.organization_id, user_id=user.id, role=role, created_by=actor.user_id)
    session.add(membership)
    session.flush()
    audit.record(session, actor, "membership.create", "membership", membership.id, after={"role": role, "user_id": user.id, "email": user.email})
    return membership


def login(session: Session, email: str, password: str, ttl_hours: int) -> tuple[User, UserSession]:
    user = session.scalar(select(User).where(User.email == email.strip().lower()))
    # Same work and same message whether the user exists or not.
    ok = user is not None and user.is_active and verify_password(password, user.password_hash)
    if not ok:
        if user is None:
            bcrypt.checkpw(b"x", bcrypt.hashpw(b"y", bcrypt.gensalt(4)))
        raise AuthError("invalid email or password")
    assert user is not None
    now = datetime.now(UTC)
    sess = UserSession(id=secrets.token_hex(16), user_id=user.id, expires_at=now + timedelta(hours=ttl_hours), last_seen_at=now, created_by=user.id)
    session.add(sess)
    session.flush()
    return user, sess


def resolve_session(session: Session, token: str | None) -> tuple[User, UserSession] | None:
    if not token or len(token) != 32:
        return None
    sess = session.get(UserSession, token)
    if sess is None or sess.revoked_at is not None or sess.expires_at < datetime.now(UTC):
        return None
    user = session.get(User, sess.user_id)
    if user is None or not user.is_active:
        return None
    sess.last_seen_at = datetime.now(UTC)
    return user, sess


def logout(session: Session, sess: UserSession) -> None:
    sess.revoked_at = datetime.now(UTC)


def memberships_of(session: Session, user: User) -> list[tuple[Membership, Organization]]:
    rows = session.execute(
        select(Membership, Organization).join(Organization, Organization.id == Membership.organization_id).where(Membership.user_id == user.id)
    ).all()
    return [(m, o) for m, o in rows]


def membership_in(session: Session, user: User, organization_id: str) -> Membership | None:
    return session.scalar(select(Membership).where(Membership.user_id == user.id, Membership.organization_id == organization_id))
