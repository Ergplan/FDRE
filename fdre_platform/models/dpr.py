"""Post-award: the award record with its frozen baseline, the DPR workspace, its
immutable versions and exported artifacts."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, IdMixin, OrgMixin


class Award(IdMixin, OrgMixin, Base):
    """The approved source run frozen at the moment of award. Immutable except for
    `status` (recorded -> superseded by a later award on the same tender)."""

    __tablename__ = "award"
    tender_id: Mapped[str] = mapped_column(String(32), ForeignKey("tender.id"), nullable=False, index=True)
    run_id: Mapped[str] = mapped_column(String(32), ForeignKey("run.id"), nullable=False, index=True)
    scenario_id: Mapped[str] = mapped_column(String(32), ForeignKey("scenario.id"), nullable=False)
    input_version_id: Mapped[str] = mapped_column(String(32), ForeignKey("scenario_input_version.id"), nullable=False)
    requirement_version_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("requirement_version.id"), nullable=True)
    awarded_tariff_inr_per_kwh: Mapped[float] = mapped_column(Float, nullable=False)
    awarded_capacity_mw: Mapped[float] = mapped_column(Float, nullable=False)
    award_date: Mapped[date] = mapped_column(Date, nullable=False)
    letter_reference: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="recorded")
    baseline: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")


class DprWorkspace(IdMixin, OrgMixin, Base):
    __tablename__ = "dpr_workspace"
    __table_args__ = (UniqueConstraint("award_id", name="uq_dpr_workspace_award"),)
    award_id: Mapped[str] = mapped_column(String(32), ForeignKey("award.id"), nullable=False)
    tender_id: Mapped[str] = mapped_column(String(32), ForeignKey("tender.id"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="draft")  # draft | in_review | issued
    current_version_no: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(32), nullable=True)


class DprVersion(IdMixin, OrgMixin, Base):
    """Immutable. `sections` is the full document at this version; traced values carry the
    run id and the result path they were read from."""

    __tablename__ = "dpr_version"
    __table_args__ = (UniqueConstraint("workspace_id", "version_no", name="uq_dpr_version_no"),)
    workspace_id: Mapped[str] = mapped_column(String(32), ForeignKey("dpr_workspace.id"), nullable=False, index=True)
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    sections: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False)
    change_note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    changed_sections: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)


class DprArtifact(IdMixin, OrgMixin, Base):
    __tablename__ = "dpr_artifact"
    workspace_id: Mapped[str] = mapped_column(String(32), ForeignKey("dpr_workspace.id"), nullable=False, index=True)
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # docx | pdf
    filename: Mapped[str] = mapped_column(String(300), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_key: Mapped[str] = mapped_column(String(300), nullable=False)
    linked_workbook_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
