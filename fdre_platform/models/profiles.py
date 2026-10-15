from __future__ import annotations

from typing import Any

from sqlalchemy import Float, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, IdMixin, OrgMixin

PROFILE_KINDS = ("generation", "price", "demand")


class Profile(IdMixin, OrgMixin, Base):
    """A validated time series: the original file, the normalised hourly series and the
    content hash that run snapshots carry. Immutable: a corrected series is a new profile."""

    __tablename__ = "profile"
    __table_args__ = (UniqueConstraint("organization_id", "sha256", name="uq_profile_org_hash"),)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False, default="generation")
    technology: Mapped[str | None] = mapped_column(String(32), nullable=True)
    basis: Mapped[str] = mapped_column(String(32), nullable=False)            # capacity_factor | mw | mwh_per_interval | inr_per_kwh
    capacity_basis: Mapped[str | None] = mapped_column(String(32), nullable=True)  # mwac | mwp_dc | installed_mw
    capacity_mw: Mapped[float | None] = mapped_column(Float, nullable=True)
    measured_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    p_level: Mapped[str | None] = mapped_column(String(8), nullable=True)
    timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    resolution_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    source_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(300), nullable=False)        # original file
    hourly: Mapped[list[float]] = mapped_column(JSONB, nullable=False)           # 8760 normalised values
    stats: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    report: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    provenance: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")
