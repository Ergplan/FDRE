"""Declarative base and the column mixins every table uses."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


def new_id() -> str:
    return uuid.uuid4().hex


class IdMixin:
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)


class CreatedMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(32), nullable=True)  # user id; null for system


class OrgMixin(CreatedMixin):
    """organization_id on every business table. Every query filters by it."""

    organization_id: Mapped[str] = mapped_column(String(32), ForeignKey("organization.id"), nullable=False, index=True)
