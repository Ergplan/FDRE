"""Amendment arrival: store and deduplicate the document, extract its requirements, create
the updated draft requirement version, compute the impact (old value, new value, evidence,
affected inputs, constraints, runs and reports, owner), mark affected outputs stale, notify
the tender's members and assign review tasks. Approval of the draft applies the
unambiguous mapped changes to draft scenarios as new input versions; everything else stays
a task. Nothing approved or completed is ever edited in place."""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from fdre_platform.config import Settings
from fdre_platform.integrations.tender_engine import Candidate, TenderEngine
from fdre_platform.models import AmendmentImpact, Membership, Requirement, RequirementVersion, ReviewTask, Run, RunArtifact, Scenario, Tender, TenderDocument
from fdre_platform.rules.catalog import BY_PATH, to_input_value
from fdre_platform.storage import LocalStorage

from . import audit, documents, notifications, requirements, scenarios, tenders
from .context import Actor
from .tenders import NotFound, ValidationFailed


def ingest(
    session: Session, settings: Settings, storage: LocalStorage, engine: TenderEngine, actor: Actor, tender_id: str, *,
    filename: str, data: bytes, kind: str, issued_on: date | None = None, effective_on: date | None = None, supersedes_document_id: str | None = None,
    source_url: str | None = None, summary_of_change: str | None = None, extract: bool = True, extractor: str = "auto", candidates: list[Candidate] | None = None,
) -> dict[str, Any]:
    """The whole arrival flow for one document. `candidates` lets a caller supply the
    requirement candidates (user entry, or a recorded set) instead of running an extractor."""
    doc = documents.upload(
        session, settings, storage, engine, actor, tender_id, filename=filename, data=data, kind=kind, issued_on=issued_on, effective_on=effective_on,
        supersedes_document_id=supersedes_document_id, source_url=source_url, summary_of_change=summary_of_change,
    )
    result: dict[str, Any] = {"document": doc, "requirement_version": None, "changes": [], "impact": None, "extractor": None}
    if not extract and candidates is None:
        return result
    tender = tenders.get(session, actor, tender_id)
    if candidates is None:
        candidates, used = documents.extract_candidates(session, settings, storage, engine, actor, doc.id, extractor=extractor)
        result["extractor"] = used
    else:
        result["extractor"] = "supplied"
        doc.extractor = "supplied"
        doc.status = "extracted"
    previous = requirements.current_version(session, tender)
    created_from = "extraction" if previous is None else "amendment"
    if previous is not None and previous.status in ("draft", "in_review"):
        # A draft is still open: the amendment's changes go into a new draft that supersedes it,
        # so the earlier draft and the approved baseline are both preserved.
        requirements.discard(session, actor, previous.id)
        previous = requirements.current_version(session, tender)
    version, changes = requirements.create_version(session, actor, tender_id, candidates, document=doc, created_from=created_from, note=summary_of_change or f"{kind}: {filename}")
    result["requirement_version"] = version
    result["changes"] = changes
    if previous is not None:
        result["impact"] = build_impact(session, actor, tender, doc, previous, version, changes)
    return result


def build_impact(session: Session, actor: Actor, tender: Tender, doc: TenderDocument, from_version: RequirementVersion, to_version: RequirementVersion, changes: list[dict[str, Any]]) -> AmendmentImpact:
    material = [c for c in changes if c["kind"] in ("added", "changed", "removed")]
    tender_scenarios = list(session.scalars(select(Scenario).where(Scenario.tender_id == tender.id)))
    runs = list(session.scalars(select(Run).where(Run.tender_id == tender.id, Run.stale.is_(False))))
    owner = tender.attributes.get("owner_user_id") or tender.created_by
    reason = f"{doc.kind} {doc.filename} (publication {doc.publication_order}) changed " + ", ".join(c["field_path"] for c in material[:10])
    enriched: list[dict[str, Any]] = []
    for c in material:
        affected_inputs = [c["input_path"]] if c["input_path"] else []
        affected_constraints = [c["constraint"]] if c["constraint"] else []
        affected_runs = [r.id for r in runs] if (affected_inputs or affected_constraints) else []
        affected_reports = [a.id for a in session.scalars(select(RunArtifact).where(RunArtifact.run_id.in_(affected_runs)))] if affected_runs else []
        enriched.append(
            {
                **c,
                "affected_inputs": affected_inputs,
                "affected_constraints": affected_constraints,
                "affected_scenario_ids": [s.id for s in tender_scenarios] if affected_inputs else [],
                "affected_run_ids": affected_runs,
                "affected_report_ids": affected_reports,
                "owner_user_id": owner,
                "needs_review": not (c["auto_apply"] and c["provenance"] == "extracted" and c["new_evidence"]),
                "review_reason": None if (c["auto_apply"] and c["provenance"] == "extracted" and c["new_evidence"]) else ("no mapped input: interpretation" if not c["input_path"] else "mapping needs interpretation or evidence is not located"),
            }
        )
    affected_run_ids = sorted({rid for c in enriched for rid in c["affected_run_ids"]})
    for r in runs:
        if r.id in affected_run_ids:
            r.stale = True
            r.stale_reason = reason
    for s in tender_scenarios:
        if s.latest_run_id in affected_run_ids:
            pass  # the run carries the stale flag; the scenario shows it through latest_run_id
    impact = AmendmentImpact(
        organization_id=actor.organization_id, tender_id=tender.id, document_id=doc.id, from_requirement_version_id=from_version.id, to_requirement_version_id=to_version.id,
        changes=enriched, affected_scenario_ids=[s.id for s in tender_scenarios], affected_run_ids=affected_run_ids, owner_user_id=owner, created_by=actor.user_id,
        summary=f"{len(material)} requirement(s) changed; {len(affected_run_ids)} run(s) marked stale",
    )
    session.add(impact)
    session.flush()
    audit.record(session, actor, "amendment.impact", "amendment_impact", impact.id, object_version=to_version.version_no, after={"document_id": doc.id, "changes": [{k: c[k] for k in ("field_path", "kind", "old_value", "new_value")} for c in material], "affected_run_ids": affected_run_ids, "owner_user_id": owner}, tender_id=tender.id)
    _notify_and_assign(session, actor, tender, doc, impact, enriched, owner)
    return impact


def _notify_and_assign(session: Session, actor: Actor, tender: Tender, doc: TenderDocument, impact: AmendmentImpact, changes: list[dict[str, Any]], owner: str | None) -> None:
    member_ids = [u.id for _, u in tenders.members(session, actor, tender.id)]
    admin_ids = [m.user_id for m in session.scalars(select(Membership).where(Membership.organization_id == tender.organization_id, Membership.role == "administrator"))]
    recipients = list(dict.fromkeys(member_ids + admin_ids))
    title = f"Amendment to {tender.name}: {len(changes)} requirement(s) changed"
    body = "; ".join(f"{c['label']}: {c['old_value']} -> {c['new_value']}" for c in changes[:6])
    notifications.notify(
        session, organization_id=tender.organization_id, user_ids=recipients, kind="amendment", title=title, body=body, link=f"/tenders/{tender.id}/amendments/{impact.id}",
        dedupe_key=f"amendment:{doc.id}", object_type="amendment_impact", object_id=impact.id, created_by=actor.user_id,
    )
    for c in changes:
        assignee = owner or (recipients[0] if recipients else None)
        create_task(
            session, actor, tender.id, assignee_user_id=assignee, kind="amendment_review", title=f"Review {c['label']}: {c['old_value']} -> {c['new_value']}",
            body=f"{doc.kind} {doc.filename}. Affected inputs: {', '.join(c['affected_inputs']) or 'none'}; constraints: {', '.join(c['affected_constraints']) or 'none'}; runs marked stale: {len(c['affected_run_ids'])}.",
            object_type="amendment_impact", object_id=impact.id, dedupe_key=f"amendment:{doc.id}:{c['field_path']}",
        )
    bid_managers = [m.user_id for m in session.scalars(select(Membership).where(Membership.organization_id == tender.organization_id, Membership.role.in_(("bid_manager", "administrator")))) if m.user_id in recipients]
    for uid in bid_managers[:1] or recipients[:1]:
        create_task(
            session, actor, tender.id, assignee_user_id=uid, kind="requirement_version_approval", title=f"Approve requirement version {impact.to_requirement_version_id[:8]} for {tender.name}",
            body="Review the changed requirements, then approve the version; approved unambiguous mappings update draft scenarios automatically.",
            object_type="requirement_version", object_id=impact.to_requirement_version_id, dedupe_key=f"approve:{impact.to_requirement_version_id}",
        )


def create_task(session: Session, actor: Actor, tender_id: str, *, assignee_user_id: str | None, kind: str, title: str, body: str = "", object_type: str | None = None, object_id: str | None = None, dedupe_key: str | None = None, due_on: date | None = None) -> ReviewTask | None:
    if dedupe_key and session.scalar(select(ReviewTask).where(ReviewTask.dedupe_key == dedupe_key)):
        return None
    task = ReviewTask(organization_id=actor.organization_id, tender_id=tender_id, assignee_user_id=assignee_user_id, kind=kind, title=title[:300], body=body, object_type=object_type, object_id=object_id, dedupe_key=dedupe_key, due_on=due_on, created_by=actor.user_id)
    session.add(task)
    session.flush()
    if assignee_user_id:
        notifications.notify(session, organization_id=actor.organization_id, user_ids=[assignee_user_id], kind="task", title=title[:300], body=body, link=f"/tasks/{task.id}", dedupe_key=f"task:{task.id}", object_type="review_task", object_id=task.id, created_by=actor.user_id)
    audit.record(session, actor, "task.create", "review_task", task.id, after={"kind": kind, "title": title, "assignee_user_id": assignee_user_id, "object_type": object_type, "object_id": object_id}, tender_id=tender_id)
    return task


def tasks_for(session: Session, actor: Actor, *, tender_id: str | None = None, mine: bool = False, status: str | None = "open") -> list[ReviewTask]:
    stmt = select(ReviewTask).where(ReviewTask.organization_id == actor.organization_id)
    if tender_id:
        tenders.get(session, actor, tender_id)
        stmt = stmt.where(ReviewTask.tender_id == tender_id)
    if mine:
        stmt = stmt.where(ReviewTask.assignee_user_id == actor.user_id)
    if status:
        stmt = stmt.where(ReviewTask.status == status)
    return list(session.scalars(stmt.order_by(ReviewTask.created_at.desc())))


def complete_task(session: Session, actor: Actor, task_id: str, *, status: str = "done") -> ReviewTask:
    task = session.get(ReviewTask, task_id)
    if task is None or task.organization_id != actor.organization_id:
        raise NotFound("task")
    tenders.get(session, actor, task.tender_id)
    if status not in ("done", "dismissed"):
        raise ValidationFailed("status must be done or dismissed")
    before = {"status": task.status}
    task.status = status
    task.completed_by = actor.user_id
    task.completed_at = datetime.now(UTC)
    session.flush()
    audit.record(session, actor, f"task.{status}", "review_task", task.id, before=before, after={"status": status}, tender_id=task.tender_id)
    return task


def impacts_for(session: Session, actor: Actor, tender_id: str) -> list[AmendmentImpact]:
    tender = tenders.get(session, actor, tender_id)
    return list(session.scalars(select(AmendmentImpact).where(AmendmentImpact.tender_id == tender.id).order_by(AmendmentImpact.created_at.desc())))


def apply_approved(session: Session, actor: Actor, version: RequirementVersion) -> list[dict[str, Any]]:
    """After a requirement version is approved: every open impact leading to it applies its
    unambiguous mapped changes to the tender's draft scenarios as new input versions.
    Returns what was applied. Changes needing interpretation are left to their tasks."""
    applied: list[dict[str, Any]] = []
    rows = {r.field_path: r for r in requirements.rows_of(session, version)}
    impacts = list(session.scalars(select(AmendmentImpact).where(AmendmentImpact.to_requirement_version_id == version.id, AmendmentImpact.status == "open")))
    drafts = list(session.scalars(select(Scenario).where(Scenario.tender_id == version.tender_id, Scenario.status == "draft")))
    system = Actor(user_id=actor.user_id, label=f"{actor.label} (auto-apply on approval)", organization_id=actor.organization_id, role="administrator", request_id=actor.request_id)
    for impact in impacts:
        updates: dict[str, Any] = {}
        for c in impact.changes:
            row = rows.get(c["field_path"])
            fdef = BY_PATH.get(c["field_path"])
            if not fdef or not fdef.input_path or not fdef.auto_apply or row is None or row.review_state not in ("accepted", "corrected") or row.value is None:
                continue
            updates[fdef.input_path] = to_input_value(fdef, row.value)
        if not updates:
            impact.status = "applied"
            impact.applied_at = datetime.now(UTC)
            continue
        for s in drafts:
            current = scenarios.current_inputs(session, s)
            inputs = dict(current.inputs) if current else {}
            new_inputs = _with_updates(inputs, updates)
            if new_inputs == inputs:
                continue
            scenarios.save_inputs(session, system, s.id, expected_revision=s.revision, inputs=new_inputs, note=f"auto-applied approved requirement version {version.version_no}: " + ", ".join(updates))
            applied.append({"scenario_id": s.id, "updates": updates})
        impact.status = "applied"
        impact.applied_at = datetime.now(UTC)
    session.flush()
    if applied:
        audit.record(session, actor, "amendment.auto_apply", "requirement_version", version.id, object_version=version.version_no, after={"applied": applied}, tender_id=version.tender_id)
    return applied


def _with_updates(inputs: dict[str, Any], updates: dict[str, Any]) -> dict[str, Any]:
    import copy

    out = copy.deepcopy(inputs)
    for path, value in updates.items():
        parts = path.split(".")
        node = out
        for p in parts[:-1]:
            node = node.setdefault(p, {})
            if not isinstance(node, dict):
                break
        else:
            node[parts[-1]] = value
    return out


def timeline(session: Session, actor: Actor, tender_id: str, limit: int = 200) -> list[dict[str, Any]]:
    """The tender's activity: audit events (uploads, versions, reviews, approvals, impacts,
    tasks, runs) in time order."""
    tender = tenders.get(session, actor, tender_id)
    events = audit.events_for_tender(session, actor.organization_id, tender.id, limit)
    return [{"at": e.at, "actor": e.actor_label, "action": e.action, "object_type": e.object_type, "object_id": e.object_id, "object_version": e.object_version, "detail": e.after, "request_id": e.request_id} for e in events]
