from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, CreatedMixin, IdMixin, OrgMixin

RESULT_KINDS = ("discovered_tariff", "awarded_tariff", "adopted_tariff", "ceiling_tariff", "cancelled", "vgf_support", "non_tariff", "ranking", "empanelment", "other")


class HistoricalAward(IdMixin, CreatedMixin, Base):
    """One row of a historical tender result. Shared reference data (no organisation): the
    stable key is (source sha256, page, bidder, allocation) because the dataset's own ids are
    positional. Units are stored as given; nothing is converted silently."""

    __tablename__ = "historical_award"
    __table_args__ = (UniqueConstraint("stable_key", name="uq_historical_award_key"),)
    stable_key: Mapped[str] = mapped_column(String(64), nullable=False)
    dataset: Mapped[str] = mapped_column(String(64), nullable=False)          # RE-tender-results@<commit>
    dataset_as_of: Mapped[date | None] = mapped_column(Date, nullable=True)
    procurer: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    tender_title: Mapped[str] = mapped_column(Text, nullable=False)
    tender_reference: Mapped[str | None] = mapped_column(String(200), nullable=True)
    tender_family: Mapped[str] = mapped_column(String(64), nullable=False, index=True)   # normalised from technology
    technology_as_stated: Mapped[str] = mapped_column(String(100), nullable=False)
    bidder: Mapped[str] = mapped_column(String(300), nullable=False)
    allocation: Mapped[str] = mapped_column(String(64), nullable=False)
    capacity: Mapped[float | None] = mapped_column(Float, nullable=True)
    capacity_unit: Mapped[str | None] = mapped_column(String(100), nullable=True)
    price: Mapped[float | None] = mapped_column(Float, nullable=True)
    price_unit: Mapped[str | None] = mapped_column(String(100), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    adopted_capacity: Mapped[float | None] = mapped_column(Float, nullable=True)
    adopted_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    result_kind: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    status_as_stated: Mapped[str] = mapped_column(String(100), nullable=False)
    award_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    date_as_stated: Mapped[str | None] = mapped_column(String(100), nullable=True)
    date_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    contract_duration_years: Mapped[int | None] = mapped_column(Integer, nullable=True)
    storage_or_delivery_conditions: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    verification: Mapped[str | None] = mapped_column(Text, nullable=True)
    flagged: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    source_id: Mapped[str] = mapped_column(String(32), nullable=False)
    source_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    source_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source_page: Mapped[str | None] = mapped_column(String(32), nullable=True)
    source_checked_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    related_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    raw: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)


class HistoricalSource(IdMixin, CreatedMixin, Base):
    __tablename__ = "historical_source"
    __table_args__ = (UniqueConstraint("sha256", name="uq_historical_source_hash"),)
    dataset: Mapped[str] = mapped_column(String(64), nullable=False)
    source_id: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    url: Mapped[str] = mapped_column(String(1000), nullable=False)
    host: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    checked_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    storage_key: Mapped[str | None] = mapped_column(String(300), nullable=True)


class Comment(IdMixin, OrgMixin, Base):
    """Tender chat and threaded comments. A comment is never edited in place: a correction
    is a new comment that references the old one; deletion is a flag."""

    __tablename__ = "comment"
    tender_id: Mapped[str] = mapped_column(String(32), ForeignKey("tender.id"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="chat")    # chat | comment | decision | system
    object_type: Mapped[str | None] = mapped_column(String(50), nullable=True)       # scenario | run | requirement | document | ...
    object_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    parent_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("comment.id"), nullable=True, index=True)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    mentions: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)   # user ids
    decision: Mapped[str | None] = mapped_column(String(32), nullable=True)           # approved | rejected | changes_requested
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    corrects_comment_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
