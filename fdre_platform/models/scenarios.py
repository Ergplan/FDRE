from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, IdMixin, OrgMixin

WORKFLOWS = ("bid_tariff", "fixed_tariff", "dpr")
SCENARIO_STATUSES = ("draft", "locked", "archived")


class Scenario(IdMixin, OrgMixin, Base):
    """A named set of inputs for a tender. Its inputs are versioned: every save is a new
    scenario_input_version; `revision` is the optimistic-concurrency counter."""

    __tablename__ = "scenario"
    tender_id: Mapped[str] = mapped_column(String(32), ForeignKey("tender.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    workflow: Mapped[str] = mapped_column(String(32), nullable=False, default="bid_tariff")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="draft")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    current_input_version_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("scenario_input_version.id", use_alter=True, name="fk_scenario_current_input"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Which run last produced results for the current inputs; stale when inputs or rules move.
    latest_run_id: Mapped[str | None] = mapped_column(String(32), nullable=True)


class ScenarioInputVersion(IdMixin, OrgMixin, Base):
    """Immutable (database trigger). One row per save."""

    __tablename__ = "scenario_input_version"
    __table_args__ = (UniqueConstraint("scenario_id", "version_no", name="uq_scenario_input_version_no"),)
    scenario_id: Mapped[str] = mapped_column(String(32), ForeignKey("scenario.id"), nullable=False, index=True)
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    inputs: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    inputs_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Which fields changed against the previous version (top-level dotted paths).
    changed_paths: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
