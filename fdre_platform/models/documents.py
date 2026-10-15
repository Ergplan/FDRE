from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, IdMixin, OrgMixin

DOCUMENT_KINDS = ("original", "corrigendum", "amendment", "clarification", "ppa", "other")
DOCUMENT_STATUSES = ("uploaded", "parsed", "extracted", "failed")
REQUIREMENT_VERSION_STATUSES = ("draft", "in_review", "approved", "superseded")
CHANGE_KINDS = ("added", "changed", "removed", "restated", "unchanged")
TASK_STATUSES = ("open", "done", "dismissed")


class TenderDocument(IdMixin, OrgMixin, Base):
    """A source document of a tender, deduplicated by sha256 within the tender, with its
    publication order, effective date and supersession."""

    __tablename__ = "tender_document"
    __table_args__ = (UniqueConstraint("tender_id", "sha256", name="uq_tender_document_hash"),)
    tender_id: Mapped[str] = mapped_column(String(32), ForeignKey("tender.id"), nullable=False, index=True)
    filename: Mapped[str] = mapped_column(String(300), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(300), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False, default="original")
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="rfs")
    publication_order: Mapped[int] = mapped_column(Integer, nullable=False)
    issued_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    effective_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    supersedes_document_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("tender_document.id"), nullable=True)
    source_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="uploaded")
    extractor: Mapped[str | None] = mapped_column(String(100), nullable=True)
    engine_tender_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    engine_version_no: Mapped[int | None] = mapped_column(Integer, nullable=True)
    engine_document_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class RequirementVersion(IdMixin, OrgMixin, Base):
    """A complete set of requirements for a tender at one point in its document chain.
    Approved versions are locked (database trigger on their rows)."""

    __tablename__ = "requirement_version"
    __table_args__ = (UniqueConstraint("tender_id", "version_no", name="uq_requirement_version_no"),)
    tender_id: Mapped[str] = mapped_column(String(32), ForeignKey("tender.id"), nullable=False, index=True)
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="draft")
    based_on_document_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("tender_document.id"), nullable=True)
    previous_version_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("requirement_version.id"), nullable=True)
    created_from: Mapped[str] = mapped_column(String(32), nullable=False, default="extraction")  # extraction | amendment | manual
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    conflicts: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)


class Requirement(IdMixin, OrgMixin, Base):
    """One requirement of one version with its value, evidence, provenance and review."""

    __tablename__ = "requirement"
    __table_args__ = (UniqueConstraint("requirement_version_id", "field_path", name="uq_requirement_version_field"),)
    requirement_version_id: Mapped[str] = mapped_column(String(32), ForeignKey("requirement_version.id"), nullable=False, index=True)
    tender_id: Mapped[str] = mapped_column(String(32), ForeignKey("tender.id"), nullable=False, index=True)
    field_path: Mapped[str] = mapped_column(String(200), nullable=False)
    label: Mapped[str] = mapped_column(String(300), nullable=False)
    section: Mapped[str] = mapped_column(String(50), nullable=False)
    value_type: Mapped[str] = mapped_column(String(32), nullable=False)
    value: Mapped[Any | None] = mapped_column(JSONB(none_as_null=True), nullable=True)
    unit: Mapped[str | None] = mapped_column(String(100), nullable=True)
    effective_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    provenance: Mapped[str] = mapped_column(String(32), nullable=False, default="extracted")
    extractor: Mapped[str | None] = mapped_column(String(100), nullable=True)
    source_document_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("tender_document.id"), nullable=True)
    # {document_id, document_version, page, clause, excerpt, bbox}
    evidence: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True), nullable=True)
    alternatives: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    review_state: Mapped[str] = mapped_column(String(32), nullable=False, default="unreviewed")
    reviewed_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    review_note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    original_value: Mapped[Any | None] = mapped_column(JSONB(none_as_null=True), nullable=True)  # before a correction
    change_kind: Mapped[str] = mapped_column(String(32), nullable=False, default="added")
    supersedes_requirement_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("requirement.id"), nullable=True)


class RuleSetVersion(IdMixin, OrgMixin, Base):
    """Executable rules compiled from one requirement version. Immutable once approved."""

    __tablename__ = "rule_set_version"
    tender_id: Mapped[str] = mapped_column(String(32), ForeignKey("tender.id"), nullable=False, index=True)
    requirement_version_id: Mapped[str] = mapped_column(String(32), ForeignKey("requirement_version.id"), nullable=False)
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="draft")
    rules: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False)
    unsupported_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    certifiable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    blocking: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    compiler_version: Mapped[str] = mapped_column(String(50), nullable=False, default="rules.compile@1")
    approved_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AmendmentImpact(IdMixin, OrgMixin, Base):
    """What an amendment changed and what it touches: per field old/new/evidence, the
    affected inputs, constraints, runs and reports, and the responsible owner."""

    __tablename__ = "amendment_impact"
    tender_id: Mapped[str] = mapped_column(String(32), ForeignKey("tender.id"), nullable=False, index=True)
    document_id: Mapped[str] = mapped_column(String(32), ForeignKey("tender_document.id"), nullable=False)
    from_requirement_version_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("requirement_version.id"), nullable=True)
    to_requirement_version_id: Mapped[str] = mapped_column(String(32), ForeignKey("requirement_version.id"), nullable=False)
    changes: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False)
    affected_scenario_ids: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    affected_run_ids: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    owner_user_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="open")  # open | applied | dismissed
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    summary: Mapped[str] = mapped_column(Text, nullable=False, default="")


class ReviewTask(IdMixin, OrgMixin, Base):
    __tablename__ = "review_task"
    tender_id: Mapped[str] = mapped_column(String(32), ForeignKey("tender.id"), nullable=False, index=True)
    assignee_user_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(50), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    object_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    object_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    dedupe_key: Mapped[str | None] = mapped_column(String(200), nullable=True, unique=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="open")
    due_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    completed_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
