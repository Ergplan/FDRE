from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, IdMixin, OrgMixin

RUN_KINDS = ("evaluate", "optimize", "validate")
RUN_STATUSES = ("queued", "running", "succeeded", "infeasible", "time_limited", "failed", "cancelled")
TERMINAL_RUN_STATUSES = ("succeeded", "infeasible", "time_limited", "failed", "cancelled")
JOB_STATUSES = ("queued", "running", "done", "failed", "cancelled")


class Run(IdMixin, OrgMixin, Base):
    """One execution of the engine on one immutable input version. A completed run is
    never changed (database trigger): a recalculation is a new run that links back."""

    __tablename__ = "run"
    tender_id: Mapped[str] = mapped_column(String(32), ForeignKey("tender.id"), nullable=False, index=True)
    scenario_id: Mapped[str] = mapped_column(String(32), ForeignKey("scenario.id"), nullable=False, index=True)
    input_version_id: Mapped[str] = mapped_column(String(32), ForeignKey("scenario_input_version.id"), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="queued", index=True)
    # Tenant, tender, scenario, creator, timestamp, document versions, inputs hash, profile
    # hashes, rules/finance/solver versions and solver settings, captured at submission.
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    metrics: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    validation: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    job_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    stale: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    stale_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    supersedes_run_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("run.id"), nullable=True)


class RunArtifact(IdMixin, OrgMixin, Base):
    __tablename__ = "run_artifact"
    run_id: Mapped[str] = mapped_column(String(32), ForeignKey("run.id"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    filename: Mapped[str] = mapped_column(String(300), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_key: Mapped[str] = mapped_column(String(300), nullable=False)


class Job(IdMixin, OrgMixin, Base):
    """Durable unit of background work claimed with SKIP LOCKED by `fdre_platform.worker`."""

    __tablename__ = "job"
    kind: Mapped[str] = mapped_column(String(50), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="queued", index=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    run_after: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    worker_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(200), nullable=True, unique=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    progress: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
