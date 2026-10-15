from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, IdMixin, OrgMixin

TENDER_FAMILIES = ("fdre", "re_rtc", "solar", "wind", "hybrid", "bess", "cfd", "other")
TENDER_STATUSES = ("draft", "active", "submitted", "awarded", "lost", "cancelled", "archived")


class Tender(IdMixin, OrgMixin, Base):
    """The platform's tender record. Documents, versions and extracted requirements live
    in tender_engine, linked through engine_tender_id (Day 2)."""

    __tablename__ = "tender"
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    procurer: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    tender_family: Mapped[str] = mapped_column(String(32), nullable=False, default="fdre")
    reference: Mapped[str | None] = mapped_column(String(200), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="draft")
    engine_tender_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    attributes: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")


class TenderMember(IdMixin, OrgMixin, Base):
    """Who may work in a tender. Administrators see every tender of their organisation."""

    __tablename__ = "tender_member"
    __table_args__ = (UniqueConstraint("tender_id", "user_id", name="uq_tender_member_once"),)
    tender_id: Mapped[str] = mapped_column(String(32), ForeignKey("tender.id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(32), ForeignKey("app_user.id"), nullable=False, index=True)
