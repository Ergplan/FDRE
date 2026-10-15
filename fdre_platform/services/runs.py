"""Runs: an immutable snapshot of everything a result depends on, queued as a job and
executed by the worker. A rerun is a new run linked to the one it supersedes."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from fdre_platform.config import Settings
from fdre_platform.models import RUN_KINDS, TERMINAL_RUN_STATUSES, Job, Run, Scenario, ScenarioInputVersion, Tender

from . import audit, jobs, scenarios, tenders
from .context import Actor
from .tenders import NotFound, ValidationFailed


def build_snapshot(settings: Settings, actor: Actor, tender: Tender, scenario: Scenario, version: ScenarioInputVersion, kind: str, solver_settings: dict[str, Any]) -> dict[str, Any]:
    inputs = version.inputs
    profiles = inputs.get("profiles") if isinstance(inputs.get("profiles"), dict) else {}
    return {
        "tenant": {"organization_id": actor.organization_id},
        "tender": {"id": tender.id, "name": tender.name, "revision": tender.revision, "engine_tender_id": tender.engine_tender_id},
        "scenario": {"id": scenario.id, "name": scenario.name, "workflow": scenario.workflow, "revision": scenario.revision},
        "creator": {"user_id": actor.user_id, "label": actor.label},
        "submitted_at": datetime.now(UTC).isoformat(),
        "documents": tender.attributes.get("document_versions", []),
        "amendments": tender.attributes.get("amendment_chain", []),
        "inputs": {"version_id": version.id, "version_no": version.version_no, "hash": version.inputs_hash},
        "profile_hashes": {name: p.get("hash") for name, p in profiles.items() if isinstance(p, dict)},
        "rules_version": tender.attributes.get("rules_version", settings.rules_version),
        "finance_version": settings.finance_version,
        "solver_version": settings.engine_version,
        "kind": kind,
        "solver_settings": solver_settings,
    }


def launch(session: Session, settings: Settings, actor: Actor, scenario_id: str, *, kind: str, solver_settings: dict[str, Any] | None = None, idempotency_key: str | None = None, supersedes_run_id: str | None = None) -> tuple[Run, Job]:
    actor.require("run.launch")
    if kind not in RUN_KINDS:
        raise ValidationFailed(f"unknown run kind {kind}")
    scenario = scenarios.get(session, actor, scenario_id)
    tender = tenders.get(session, actor, scenario.tender_id)
    version = scenarios.current_inputs(session, scenario)
    if version is None:
        raise ValidationFailed("scenario has no saved inputs")
    solver_settings = solver_settings or {}
    if idempotency_key:
        existing = session.scalar(select(Job).where(Job.idempotency_key == idempotency_key))
        if existing is not None:
            run = session.get(Run, existing.payload.get("run_id", ""))
            if run is not None and run.organization_id == actor.organization_id:
                return run, existing
    snapshot = build_snapshot(settings, actor, tender, scenario, version, kind, solver_settings)
    run = Run(organization_id=actor.organization_id, tender_id=tender.id, scenario_id=scenario.id, input_version_id=version.id, kind=kind, snapshot=snapshot, created_by=actor.user_id, supersedes_run_id=supersedes_run_id)
    session.add(run)
    session.flush()
    job = jobs.enqueue(session, organization_id=actor.organization_id, kind="run", payload={"run_id": run.id}, created_by=actor.user_id, idempotency_key=idempotency_key)
    run.job_id = job.id
    session.flush()
    audit.record(session, actor, "run.launch", "run", run.id, object_version=version.version_no, after={"kind": kind, "scenario_id": scenario.id, "input_version_id": version.id, "inputs_hash": version.inputs_hash, "job_id": job.id})
    return run, job


def get(session: Session, actor: Actor, run_id: str) -> Run:
    run = session.get(Run, run_id)
    if run is None or run.organization_id != actor.organization_id:
        raise NotFound("run")
    tenders.get(session, actor, run.tender_id)
    return run


def list_for_scenario(session: Session, actor: Actor, scenario_id: str) -> list[Run]:
    scenario = scenarios.get(session, actor, scenario_id)
    return list(session.scalars(select(Run).where(Run.scenario_id == scenario.id).order_by(Run.created_at.desc())))


def list_for_tender(session: Session, actor: Actor, tender_id: str) -> list[Run]:
    tender = tenders.get(session, actor, tender_id)
    return list(session.scalars(select(Run).where(Run.tender_id == tender.id).order_by(Run.created_at.desc())))


def cancel(session: Session, actor: Actor, run_id: str) -> Run:
    actor.require("run.cancel")
    run = get(session, actor, run_id)
    if run.status in TERMINAL_RUN_STATUSES:
        raise ValidationFailed(f"run is already {run.status}")
    job = session.get(Job, run.job_id) if run.job_id else None
    if job is not None:
        jobs.request_cancel(session, job)
        if job.status == "cancelled":
            run.status = "cancelled"
            run.finished_at = datetime.now(UTC)
    session.flush()
    audit.record(session, actor, "run.cancel", "run", run.id, after={"status": run.status, "job_status": job.status if job else None})
    return run
