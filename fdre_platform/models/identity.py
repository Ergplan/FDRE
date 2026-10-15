from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, CreatedMixin, IdMixin


class Organization(IdMixin, CreatedMixin, Base):
    __tablename__ = "organization"
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)


class User(IdMixin, CreatedMixin, Base):
    __tablename__ = "app_user"
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(200), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Membership(IdMixin, CreatedMixin, Base):
    __tablename__ = "membership"
    __table_args__ = (UniqueConstraint("organization_id", "user_id", name="uq_membership_org_user"),)
    organization_id: Mapped[str] = mapped_column(String(32), ForeignKey("organization.id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(32), ForeignKey("app_user.id"), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(32), nullable=False)


class UserSession(IdMixin, CreatedMixin, Base):
    """A login. The id is random; the client holds it in an HttpOnly cookie or bearer header."""

    __tablename__ = "user_session"
    user_id: Mapped[str] = mapped_column(String(32), ForeignKey("app_user.id"), nullable=False, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
