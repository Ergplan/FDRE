from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, IdMixin, OrgMixin


class Notification(IdMixin, OrgMixin, Base):
    """Per-user notification with delivery attempts and deduplication by dedupe_key."""

    __tablename__ = "notification"
    __table_args__ = (UniqueConstraint("organization_id", "user_id", "dedupe_key", name="uq_notification_dedupe"),)
    user_id: Mapped[str] = mapped_column(String(32), ForeignKey("app_user.id"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(50), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    link: Mapped[str | None] = mapped_column(String(500), nullable=True)
    dedupe_key: Mapped[str] = mapped_column(String(200), nullable=False)
    object_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    object_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    delivery_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    delivery_error: Mapped[str | None] = mapped_column(Text, nullable=True)
