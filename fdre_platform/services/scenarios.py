"""Scenarios and their versioned inputs. Saving is an optimistic-concurrency write: the
client sends the revision it loaded; a different current revision is a 409 with the
conflicting paths, never a silent overwrite."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from fdre_platform.models import SCENARIO_STATUSES, WORKFLOWS, Run, Scenario, ScenarioInputVersion

from . import audit, tenders
from .context import Actor
from .tenders import Conflict, NotFound, ValidationFailed


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def inputs_hash(inputs: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(inputs).encode()).hexdigest()


def flatten(value: Any, prefix: str = "") -> dict[str, Any]:
    """Dotted leaf paths for change detection. Lists are compared whole."""
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            out.update(flatten(v, f"{prefix}{k}."))
        return out
    return {prefix[:-1]: value}


def changed_paths(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    a, b = flatten(before), flatten(after)
    return sorted(p for p in set(a) | set(b) if canonical_json(a.get(p)) != canonical_json(b.get(p)))


def _dump(s: Scenario) -> dict[str, Any]:
    return {"name": s.name, "workflow": s.workflow, "status": s.status, "description": s.description, "tender_id": s.tender_id}


def create(session: Session, actor: Actor, tender_id: str, *, name: str, workflow: str = "bid_tariff", description: str = "", inputs: dict[str, Any] | None = None) -> Scenario:
    actor.require("scenario.create")
    tender = tenders.get(session, actor, tender_id)
    if workflow not in WORKFLOWS:
        raise ValidationFailed(f"unknown workflow {workflow}")
    if not name.strip():
        raise ValidationFailed("name is required")
    scenario = Scenario(organization_id=actor.organization_id, tender_id=tender.id, name=name.strip(), workflow=workflow, description=description, created_by=actor.user_id, updated_by=actor.user_id)
    session.add(scenario)
    session.flush()
    audit.record(session, actor, "scenario.create", "scenario", scenario.id, object_version=0, after=_dump(scenario), tender_id=tender.id)
    if inputs is not None:
        save_inputs(session, actor, scenario.id, expected_revision=0, inputs=inputs, note="initial inputs")
    return scenario


def list_for_tender(session: Session, actor: Actor, tender_id: str) -> list[Scenario]:
    tender = tenders.get(session, actor, tender_id)
    return list(session.scalars(select(Scenario).where(Scenario.tender_id == tender.id, Scenario.organization_id == actor.organization_id).order_by(Scenario.updated_at.desc())))


def get(session: Session, actor: Actor, scenario_id: str) -> Scenario:
    scenario = session.get(Scenario, scenario_id)
    if scenario is None or scenario.organization_id != actor.organization_id:
        raise NotFound("scenario")
    tenders.get(session, actor, scenario.tender_id)  # membership check
    return scenario


def current_inputs(session: Session, scenario: Scenario) -> ScenarioInputVersion | None:
    if scenario.current_input_version_id is None:
        return None
    return session.get(ScenarioInputVersion, scenario.current_input_version_id)


def versions(session: Session, actor: Actor, scenario_id: str) -> list[ScenarioInputVersion]:
    scenario = get(session, actor, scenario_id)
    return list(session.scalars(select(ScenarioInputVersion).where(ScenarioInputVersion.scenario_id == scenario.id).order_by(ScenarioInputVersion.version_no)))


def save_inputs(session: Session, actor: Actor, scenario_id: str, *, expected_revision: int, inputs: dict[str, Any], note: str = "") -> ScenarioInputVersion:
    """Write a new input version. Finance keys need finance.edit; everything else scenario.edit."""
    scenario = session.execute(select(Scenario).where(Scenario.id == scenario_id).with_for_update()).scalar_one_or_none()
    if scenario is None or scenario.organization_id != actor.organization_id:
        raise NotFound("scenario")
    tenders.get(session, actor, scenario.tender_id)
    if scenario.status != "draft":
        raise ValidationFailed(f"scenario is {scenario.status}; create a new scenario to change it")
    if not isinstance(inputs, dict):
        raise ValidationFailed("inputs must be an object")
    current = current_inputs(session, scenario)
    previous = current.inputs if current else {}
    changes = changed_paths(previous, inputs)
    if scenario.revision != expected_revision:
        theirs = changed_paths(previous, inputs)
        raise Conflict("scenario inputs changed since you loaded them", scenario.revision, theirs)
    needs_finance = any(_is_finance_path(p) for p in changes)
    needs_technical = any(not _is_finance_path(p) for p in changes)
    if needs_finance:
        actor.require("finance.edit")
    if needs_technical:
        actor.require("scenario.edit")
    if not changes and not (actor.can("scenario.edit") or actor.can("finance.edit")):
        actor.require("scenario.edit")
    version = ScenarioInputVersion(
        organization_id=actor.organization_id, scenario_id=scenario.id, version_no=(current.version_no + 1 if current else 1),
        inputs=inputs, inputs_hash=inputs_hash(inputs), note=note, changed_paths=changes, created_by=actor.user_id,
    )
    session.add(version)
    session.flush()
    scenario.current_input_version_id = version.id
    scenario.revision += 1
    scenario.updated_at = datetime.now(UTC)
    scenario.updated_by = actor.user_id
    if changes:
        _mark_runs_stale(session, scenario, f"inputs changed in version {version.version_no}: {', '.join(changes[:12])}")
    session.flush()
    audit.record(
        session, actor, "scenario.inputs.save", "scenario", scenario.id, object_version=scenario.revision,
        before={"input_version": current.version_no if current else None, "inputs_hash": current.inputs_hash if current else None},
        after={"input_version": version.version_no, "inputs_hash": version.inputs_hash, "changed_paths": changes, "note": note},
        tender_id=scenario.tender_id,
    )
    return version


FINANCE_PREFIXES = ("finance.", "settings.finance.", "project.finance.")


def _is_finance_path(path: str) -> bool:
    return path.startswith(FINANCE_PREFIXES)


def _mark_runs_stale(session: Session, scenario: Scenario, reason: str) -> None:
    for run in session.scalars(select(Run).where(Run.scenario_id == scenario.id, Run.stale.is_(False))):
        run.stale = True
        run.stale_reason = reason


def update(session: Session, actor: Actor, scenario_id: str, *, expected_revision: int, name: str | None = None, description: str | None = None, status: str | None = None) -> Scenario:
    scenario = session.execute(select(Scenario).where(Scenario.id == scenario_id).with_for_update()).scalar_one_or_none()
    if scenario is None or scenario.organization_id != actor.organization_id:
        raise NotFound("scenario")
    tenders.get(session, actor, scenario.tender_id)
    if scenario.revision != expected_revision:
        raise Conflict("scenario changed since you loaded it", scenario.revision)
    before = _dump(scenario)
    if status is not None:
        if status not in SCENARIO_STATUSES:
            raise ValidationFailed("unknown status")
        actor.require("scenario.lock" if status != "draft" else "scenario.edit")
        scenario.status = status
    if name is not None or description is not None:
        actor.require("scenario.edit")
        if name is not None:
            scenario.name = name.strip() or scenario.name
        if description is not None:
            scenario.description = description
    scenario.revision += 1
    scenario.updated_at = datetime.now(UTC)
    scenario.updated_by = actor.user_id
    session.flush()
    audit.record(session, actor, "scenario.update", "scenario", scenario.id, object_version=scenario.revision, before=before, after=_dump(scenario))
    return scenario
