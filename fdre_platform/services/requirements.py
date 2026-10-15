"""Requirement versions: a complete set of requirements per point in the document chain.
Extraction produces candidates; a version holds rows with value, evidence, provenance and
review state; approval locks the version and compiles the executable rule set."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from fdre_platform.integrations.tender_engine import Candidate
from fdre_platform.models import Requirement, RequirementVersion, RuleSetVersion, Tender, TenderDocument
from fdre_platform.rules.catalog import BY_PATH, PROVENANCES, REVIEW_STATES
from fdre_platform.rules.compile import compile_rules

from . import audit, tenders
from .context import Actor
from .tenders import NotFound, ValidationFailed


def _same(a: Any, b: Any) -> bool:
    return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)


def _req_dict(r: Requirement) -> dict[str, Any]:
    return {
        "id": r.id, "field_path": r.field_path, "label": r.label, "section": r.section, "value_type": r.value_type, "value": r.value, "unit": r.unit,
        "effective_date": r.effective_date.isoformat() if r.effective_date else None, "confidence": r.confidence, "provenance": r.provenance,
        "extractor": r.extractor, "source_document_id": r.source_document_id, "evidence": r.evidence, "alternatives": r.alternatives,
        "review_state": r.review_state, "reviewed_by": r.reviewed_by, "review_note": r.review_note, "original_value": r.original_value,
        "change_kind": r.change_kind, "supersedes_requirement_id": r.supersedes_requirement_id,
    }


def current_version(session: Session, tender: Tender, *, approved_only: bool = False) -> RequirementVersion | None:
    stmt = select(RequirementVersion).where(RequirementVersion.tender_id == tender.id)
    if approved_only:
        stmt = stmt.where(RequirementVersion.status == "approved")
    else:
        stmt = stmt.where(RequirementVersion.status.in_(("draft", "in_review", "approved")))
    return session.scalar(stmt.order_by(RequirementVersion.version_no.desc()).limit(1))


def rows_of(session: Session, version: RequirementVersion) -> list[Requirement]:
    return list(session.scalars(select(Requirement).where(Requirement.requirement_version_id == version.id).order_by(Requirement.section, Requirement.field_path)))


def get_version(session: Session, actor: Actor, version_id: str) -> RequirementVersion:
    v = session.get(RequirementVersion, version_id)
    if v is None or v.organization_id != actor.organization_id:
        raise NotFound("requirement version")
    tenders.get(session, actor, v.tender_id)
    return v


def versions_for(session: Session, actor: Actor, tender_id: str) -> list[RequirementVersion]:
    tender = tenders.get(session, actor, tender_id)
    return list(session.scalars(select(RequirementVersion).where(RequirementVersion.tender_id == tender.id).order_by(RequirementVersion.version_no)))


def diff_candidates(previous_rows: list[Requirement], candidates: list[Candidate]) -> list[dict[str, Any]]:
    """What a candidate set says against the rows that stood before: one change per field
    the candidates address. kind: added | changed | restated | removed (value None stated)."""
    prev = {r.field_path: r for r in previous_rows}
    changes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for c in candidates:
        if c.field_path in seen:
            continue
        seen.add(c.field_path)
        before = prev.get(c.field_path)
        fdef = BY_PATH.get(c.field_path)
        if before is None or before.value is None:
            kind = "added" if c.value is not None else "restated"
        elif c.value is None:
            kind = "removed"
        elif _same(before.value, c.value):
            kind = "restated"
        else:
            kind = "changed"
        changes.append(
            {
                "field_path": c.field_path, "label": fdef.label if fdef else c.field_path, "kind": kind,
                "old_value": before.value if before else None, "new_value": c.value, "unit": fdef.unit if fdef else c.unit,
                "old_evidence": before.evidence if before else None, "new_evidence": c.evidence,
                "provenance": c.provenance, "confidence": c.confidence, "extractor": c.extractor, "source": c.source,
                "input_path": fdef.input_path if fdef else None, "constraint": fdef.constraint if fdef else None, "auto_apply": bool(fdef and fdef.auto_apply),
            }
        )
    return changes


def create_version(
    session: Session, actor: Actor, tender_id: str, candidates: list[Candidate], *, document: TenderDocument | None, created_from: str, note: str = "",
) -> tuple[RequirementVersion, list[dict[str, Any]]]:
    """A new draft version: rows carried from the latest version plus the candidates'
    changes. Returns the version and the field-level changes against the previous one.
    Unknown field paths are kept (section 'other') so nothing an extractor says is lost."""
    actor.require("tender.edit")
    tender = tenders.get(session, actor, tender_id)
    previous = current_version(session, tender)
    if previous is not None and previous.status in ("draft", "in_review") and created_from == "extraction":
        raise ValidationFailed(f"requirement version {previous.version_no} is still {previous.status}; approve or discard it before extracting again")
    prev_rows = rows_of(session, previous) if previous else []
    changes = diff_candidates(prev_rows, candidates)
    version = RequirementVersion(
        organization_id=actor.organization_id, tender_id=tender.id, version_no=(previous.version_no + 1 if previous else 1), status="draft",
        based_on_document_id=document.id if document else None, previous_version_id=previous.id if previous else None, created_from=created_from, note=note, created_by=actor.user_id,
    )
    session.add(version)
    session.flush()
    by_path = {c["field_path"]: c for c in changes}
    cand_by_path = {c.field_path: c for c in candidates}
    conflicts: list[dict[str, Any]] = []
    # Carry every previous row.
    for r in prev_rows:
        ch = by_path.get(r.field_path)
        if ch is None or ch["kind"] == "restated":
            row = _copy_row(r, version, change_kind="unchanged" if ch is None else "restated")
            if ch is not None:
                row.alternatives = [*r.alternatives, {"value": ch["new_value"], "evidence": ch["new_evidence"], "document_id": document.id if document else None, "note": "restated"}]
            session.add(row)
            continue
        c = cand_by_path[r.field_path]
        row = Requirement(
            organization_id=actor.organization_id, requirement_version_id=version.id, tender_id=tender.id, field_path=r.field_path, label=r.label, section=r.section,
            value_type=r.value_type, value=c.value, unit=c.unit or r.unit, effective_date=c.effective_date or (document.effective_on if document else None), confidence=c.confidence,
            provenance=c.provenance, extractor=c.extractor, source_document_id=document.id if document else r.source_document_id, evidence=c.evidence,
            alternatives=[{"value": r.value, "evidence": r.evidence, "document_id": r.source_document_id, "note": "previous version"}], review_state="unreviewed",
            change_kind=ch["kind"], supersedes_requirement_id=r.id, created_by=actor.user_id,
        )
        session.add(row)
    # Add new fields.
    for c in candidates:
        ch = by_path[c.field_path]
        if ch["kind"] != "added" or any(r.field_path == c.field_path for r in prev_rows):
            continue
        fdef = BY_PATH.get(c.field_path)
        session.add(
            Requirement(
                organization_id=actor.organization_id, requirement_version_id=version.id, tender_id=tender.id, field_path=c.field_path,
                label=fdef.label if fdef else c.field_path, section=fdef.section if fdef else "other", value_type=fdef.value_type if fdef else _guess_type(c.value),
                value=c.value, unit=c.unit or (fdef.unit if fdef else None), effective_date=c.effective_date or (document.effective_on if document else None), confidence=c.confidence,
                provenance=c.provenance if c.provenance in PROVENANCES else "extracted", extractor=c.extractor, source_document_id=document.id if document else None, evidence=c.evidence,
                review_state="unreviewed", change_kind="added", created_by=actor.user_id,
            )
        )
    # Contradictions: two candidates for one field with different values in the same set.
    seen: dict[str, Candidate] = {}
    for c in candidates:
        first = seen.get(c.field_path)
        if first is None:
            seen[c.field_path] = c
        elif not _same(first.value, c.value):
            conflicts.append({"field_path": c.field_path, "values": [first.value, c.value], "evidence": [first.evidence, c.evidence]})
    session.flush()
    if conflicts:
        version.conflicts = conflicts
        for row in rows_of(session, version):
            if any(k["field_path"] == row.field_path for k in conflicts):
                row.review_state = "conflicted"
    session.flush()
    audit.record(
        session, actor, "requirement_version.create", "requirement_version", version.id, object_version=version.version_no,
        after={"created_from": created_from, "document_id": document.id if document else None, "changes": [{k: c[k] for k in ("field_path", "kind", "old_value", "new_value")} for c in changes if c["kind"] != "restated"], "conflicts": len(conflicts)},
        tender_id=tender.id,
    )
    return version, changes


def _copy_row(r: Requirement, version: RequirementVersion, *, change_kind: str) -> Requirement:
    return Requirement(
        organization_id=r.organization_id, requirement_version_id=version.id, tender_id=r.tender_id, field_path=r.field_path, label=r.label, section=r.section,
        value_type=r.value_type, value=r.value, unit=r.unit, effective_date=r.effective_date, confidence=r.confidence, provenance=r.provenance, extractor=r.extractor,
        source_document_id=r.source_document_id, evidence=r.evidence, alternatives=list(r.alternatives), review_state=r.review_state, reviewed_by=r.reviewed_by,
        reviewed_at=r.reviewed_at, review_note=r.review_note, original_value=r.original_value, change_kind=change_kind, supersedes_requirement_id=r.id, created_by=version.created_by,
    )


def _guess_type(value: Any) -> str:
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, (int, float)):
        return "decimal"
    if isinstance(value, (list, dict)):
        return "record"
    return "text"


def review(session: Session, actor: Actor, requirement_id: str, *, decision: str, value: Any = None, note: str = "", evidence: dict[str, Any] | None = None) -> Requirement:
    """accept | correct | reject. A correction keeps the original value and needs evidence
    (page and excerpt) when the row had none."""
    actor.require("requirement.review")
    row = session.get(Requirement, requirement_id)
    if row is None or row.organization_id != actor.organization_id:
        raise NotFound("requirement")
    version = get_version(session, actor, row.requirement_version_id)
    if version.locked_at is not None:
        raise ValidationFailed(f"requirement version {version.version_no} is locked")
    before = _req_dict(row)
    if decision == "accept":
        if row.value is None:
            raise ValidationFailed("nothing to accept: the requirement has no value")
        row.review_state = "accepted"
    elif decision == "correct":
        if value is None:
            raise ValidationFailed("a correction needs a value")
        ev = evidence or row.evidence
        if not ev or not ev.get("page") or not ev.get("excerpt"):
            raise ValidationFailed("a correction needs evidence: page and excerpt")
        row.original_value = row.original_value if row.original_value is not None else row.value
        row.value = value
        row.evidence = ev
        row.provenance = "user_entered"
        row.review_state = "corrected"
    elif decision == "reject":
        row.review_state = "rejected"
    else:
        raise ValidationFailed("decision must be accept, correct or reject")
    row.reviewed_by = actor.user_id
    row.reviewed_at = datetime.now(UTC)
    row.review_note = note
    if version.status == "draft":
        version.status = "in_review"
    session.flush()
    audit.record(session, actor, f"requirement.{decision}", "requirement", row.id, object_version=version.version_no, before=before, after=_req_dict(row), tender_id=row.tender_id)
    return row


def compiled(session: Session, version: RequirementVersion) -> dict[str, Any]:
    return compile_rules([_req_dict(r) for r in rows_of(session, version)])


def approve(session: Session, actor: Actor, version_id: str) -> tuple[RequirementVersion, RuleSetVersion]:
    """Lock the version, supersede the previous approved one, compile and store the rule set."""
    actor.require("bid.approve") if actor.can("bid.approve") else actor.require("tender.edit")
    version = get_version(session, actor, version_id)
    if version.status == "approved":
        raise ValidationFailed("already approved")
    rows = rows_of(session, version)
    unreviewed = [r.field_path for r in rows if r.review_state in ("unreviewed", "conflicted") and r.value is not None and r.change_kind != "unchanged"]
    if unreviewed:
        raise ValidationFailed(f"{len(unreviewed)} requirement(s) still need review: {', '.join(unreviewed[:8])}")
    now = datetime.now(UTC)
    for earlier in session.scalars(select(RequirementVersion).where(RequirementVersion.tender_id == version.tender_id, RequirementVersion.status == "approved", RequirementVersion.id != version.id)):
        earlier.status = "superseded"
    version.status = "approved"
    version.locked_at = now
    version.approved_by = actor.user_id
    version.approved_at = now
    result = compile_rules([_req_dict(r) for r in rows])
    last = session.scalar(select(RuleSetVersion).where(RuleSetVersion.tender_id == version.tender_id).order_by(RuleSetVersion.version_no.desc()).limit(1))
    rule_set = RuleSetVersion(
        organization_id=actor.organization_id, tender_id=version.tender_id, requirement_version_id=version.id, version_no=(last.version_no + 1 if last else 1),
        status="approved", rules=result["rules"], unsupported_count=result["unsupported_count"], certifiable=result["certifiable"], blocking=result["blocking"],
        approved_by=actor.user_id, approved_at=now, created_by=actor.user_id,
    )
    session.add(rule_set)
    tender = session.get(Tender, version.tender_id)
    assert tender is not None
    tender.attributes = {**tender.attributes, "rules_version": f"rule_set:{rule_set.version_no}", "requirement_version": version.version_no}
    session.flush()
    audit.record(session, actor, "requirement_version.approve", "requirement_version", version.id, object_version=version.version_no, after={"rule_set_version": rule_set.version_no, "certifiable": rule_set.certifiable, "blocking": rule_set.blocking}, tender_id=version.tender_id)
    return version, rule_set


def discard(session: Session, actor: Actor, version_id: str) -> RequirementVersion:
    actor.require("tender.edit")
    version = get_version(session, actor, version_id)
    if version.status not in ("draft", "in_review"):
        raise ValidationFailed("only a draft can be discarded")
    version.status = "superseded"
    version.note = (version.note + "\ndiscarded").strip()
    session.flush()
    audit.record(session, actor, "requirement_version.discard", "requirement_version", version.id, object_version=version.version_no, tender_id=version.tender_id)
    return version


def validate_state(state: str) -> str:
    if state not in REVIEW_STATES:
        raise ValidationFailed("unknown review state")
    return state
