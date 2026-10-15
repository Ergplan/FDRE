"""Postgres-backed durable job queue: FOR UPDATE SKIP LOCKED claims, leases with heartbeat,
bounded retries with backoff, cancellation flags, idempotency keys. No other queue."""

from __future__ import annotations

import socket
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from fdre_platform.models import Job

BACKOFF_SECONDS = 15


class DuplicateJob(Exception):
    def __init__(self, job: Job) -> None:
        super().__init__("a job with this idempotency key exists")
        self.job = job


def worker_identity() -> str:
    return f"{socket.gethostname()}:{datetime.now(UTC).strftime('%H%M%S')}"


def enqueue(session: Session, *, organization_id: str, kind: str, payload: dict[str, Any], created_by: str | None, idempotency_key: str | None = None, max_attempts: int = 3) -> Job:
    if idempotency_key:
        existing = session.scalar(select(Job).where(Job.idempotency_key == idempotency_key))
        if existing is not None:
            if existing.organization_id != organization_id or existing.payload != payload:
                raise DuplicateJob(existing)
            return existing
    job = Job(organization_id=organization_id, kind=kind, payload=payload, created_by=created_by, idempotency_key=idempotency_key, max_attempts=max_attempts)
    session.add(job)
    session.flush()
    return job


def claim_next(session: Session, worker_id: str, lease_seconds: int, kinds: tuple[str, ...] | None = None) -> Job | None:
    """Claim the oldest due job across organisations. A running job whose lease expired is
    claimable again (its worker died). Commits."""
    now = datetime.now(UTC)
    stmt = (
        select(Job)
        .where(or_(Job.status == "queued", (Job.status == "running") & (Job.lease_until < now)), Job.run_after <= now)
        .order_by(Job.run_after, Job.created_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    if kinds:
        stmt = stmt.where(Job.kind.in_(kinds))
    job = session.scalar(stmt)
    if job is None:
        session.rollback()
        return None
    if job.status == "running":
        job.last_error = (job.last_error or "") + "\nlease expired; reclaimed"
    job.status = "running"
    job.attempts += 1
    job.started_at = job.started_at or now
    job.worker_id = worker_id
    job.lease_until = now + timedelta(seconds=lease_seconds)
    session.commit()
    return job


def heartbeat(session: Session, job_id: str, lease_seconds: int, progress: dict[str, Any] | None = None) -> bool:
    """Extend the lease; returns False when cancellation was requested."""
    job = session.get(Job, job_id)
    if job is None:
        return False
    job.lease_until = datetime.now(UTC) + timedelta(seconds=lease_seconds)
    if progress is not None:
        job.progress = progress
    session.commit()
    return not job.cancel_requested


def complete(session: Session, job_id: str) -> None:
    job = session.get(Job, job_id)
    assert job is not None
    job.status = "done"
    job.finished_at = datetime.now(UTC)
    job.lease_until = None
    session.commit()


def cancel_done(session: Session, job_id: str) -> None:
    job = session.get(Job, job_id)
    assert job is not None
    job.status = "cancelled"
    job.finished_at = datetime.now(UTC)
    job.lease_until = None
    session.commit()


def fail(session: Session, job_id: str, error: str, *, retryable: bool = True) -> Job:
    job = session.get(Job, job_id)
    assert job is not None
    job.last_error = error[-4000:]
    job.lease_until = None
    if retryable and job.attempts < job.max_attempts:
        job.status = "queued"
        job.run_after = datetime.now(UTC) + timedelta(seconds=BACKOFF_SECONDS * 2 ** (job.attempts - 1))
    else:
        job.status = "failed"
        job.finished_at = datetime.now(UTC)
    session.commit()
    return job


def request_cancel(session: Session, job: Job) -> None:
    if job.status == "queued":
        job.status = "cancelled"
        job.finished_at = datetime.now(UTC)
    elif job.status == "running":
        job.cancel_requested = True
