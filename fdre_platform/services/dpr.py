"""Post-award DPR. An award freezes the approved source run (its inputs, result, rules and
requirement versions) into a baseline; the DPR workspace is generated from that baseline
with every number carrying the run id and result path it came from; narrative is edited
in immutable versions with revision checks; exports (DOCX, PDF via LibreOffice) are
stored artifacts linked to the run's workbook."""

from __future__ import annotations

import hashlib
import io
import pathlib
import re
import shutil
import subprocess
import tempfile
from datetime import UTC, date, datetime
from typing import Any

from docx import Document
from docx.shared import Pt
from sqlalchemy import select
from sqlalchemy.orm import Session

from fdre_platform.models import Award, DprArtifact, DprVersion, DprWorkspace, Requirement, RequirementVersion, Run, RunArtifact, Scenario, ScenarioInputVersion
from fdre_platform.services import audit, requirements, runs, tenders
from fdre_platform.services.context import Actor
from fdre_platform.services.tenders import Conflict, NotFound, ValidationFailed
from fdre_platform.storage import LocalStorage

WORKSPACE_STATUSES = ("draft", "in_review", "issued")
_PATH = re.compile(r"([^.\[\]]+)|\[(\d+)\]")


def get_path(obj: Any, path: str) -> Any:
    cur = obj
    for key, idx in _PATH.findall(path):
        if cur is None:
            return None
        if idx:
            cur = cur[int(idx)] if isinstance(cur, list) and int(idx) < len(cur) else None
        else:
            cur = cur.get(key) if isinstance(cur, dict) else None
    return cur


def _now() -> datetime:
    return datetime.now(UTC)


# ------------------------------------------------------------------------------- awards


def record_award(
    session: Session, actor: Actor, run_id: str, *, tariff_inr_per_kwh: float, capacity_mw: float, award_date: date, letter_reference: str = "", note: str = ""
) -> Award:
    actor.require("bid.approve")
    run = runs.get(session, actor, run_id)
    if run.status != "succeeded":
        raise ValidationFailed(f"only a succeeded run can be awarded (run is {run.status})")
    if run.stale:
        raise ValidationFailed(f"run is stale ({run.stale_reason}); rerun on the current inputs before awarding")
    if run.kind not in ("bid_tariff", "fixed_tariff"):
        raise ValidationFailed("award needs a bid_tariff or fixed_tariff run")
    if tariff_inr_per_kwh <= 0 or capacity_mw <= 0:
        raise ValidationFailed("tariff and capacity must be positive")
    tender = tenders.get(session, actor, run.tender_id)
    scenario = session.get(Scenario, run.scenario_id)
    version = session.get(ScenarioInputVersion, run.input_version_id)
    req_version = requirements.current_version(session, tender, approved_only=True)
    res = run.result or {}
    term = res.get("term") or {}
    inputs = version.inputs if version else {}
    reqs = []
    if req_version is not None:
        for r in requirements.rows_of(session, req_version):
            if r.review_state != "rejected":
                reqs.append(
                    {
                        "requirement_id": r.id,
                        "field_path": r.field_path,
                        "label": r.label,
                        "value": r.value,
                        "unit": r.unit,
                        "review_state": r.review_state,
                        "page": (r.evidence or {}).get("page"),
                    }
                )
    baseline = {
        "frozen_at": _now().isoformat(),
        "run": {
            "id": run.id,
            "kind": run.kind,
            "status": run.status,
            "created_at": run.created_at.isoformat(),
            "finished_at": run.finished_at.isoformat() if run.finished_at else None,
            "inputs_hash": (run.snapshot.get("inputs") or {}).get("hash"),
            "rules_version": run.snapshot.get("rules_version"),
            "engine_version": run.snapshot.get("engine_version"),
            "finance_version": run.snapshot.get("finance_version"),
            "solver": (run.metrics or {}).get("solver"),
        },
        "scenario": {
            "id": scenario.id if scenario else run.scenario_id,
            "name": scenario.name if scenario else None,
            "revision_at_award": scenario.revision if scenario else None,
            "input_version_id": run.input_version_id,
            "input_version_no": version.version_no if version else None,
        },
        "inputs": {
            "supply": inputs.get("supply"),
            "settings": inputs.get("settings"),
            "run_options": inputs.get("run_options"),
            "contracted_capacity_mw": ((inputs.get("project") or {}).get("tender") or {}).get("contracted_capacity_mw"),
        },
        "result": {
            "tariff": res.get("tariff"),
            "tariff_label": res.get("tariff_label"),
            "search_status": res.get("search_status"),
            "finance": res.get("finance"),
            "term": {
                "status": term.get("status"),
                "years_solved": term.get("years_solved"),
                "years_interpolated": term.get("years_interpolated"),
                "per_year": term.get("per_year"),
                "certification_year1": term.get("certification_year1"),
            },
            "assumptions": res.get("assumptions"),
            "binding": res.get("binding"),
            "sensitivities": res.get("sensitivities"),
        },
        "metrics": run.metrics,
        "requirements": {"version_id": req_version.id if req_version else None, "version_no": req_version.version_no if req_version else None, "items": reqs},
        "tender": {"id": tender.id, "name": tender.name, "procurer": tender.procurer, "reference": tender.reference, "family": tender.tender_family},
    }
    for prev in session.scalars(select(Award).where(Award.tender_id == tender.id, Award.organization_id == actor.organization_id, Award.status == "recorded")):
        prev.status = "superseded"
    award = Award(
        organization_id=actor.organization_id,
        created_by=actor.user_id,
        tender_id=tender.id,
        run_id=run.id,
        scenario_id=run.scenario_id,
        input_version_id=run.input_version_id,
        requirement_version_id=req_version.id if req_version else None,
        awarded_tariff_inr_per_kwh=float(tariff_inr_per_kwh),
        awarded_capacity_mw=float(capacity_mw),
        award_date=award_date,
        letter_reference=letter_reference[:200],
        baseline=baseline,
        note=note,
    )
    session.add(award)
    session.flush()
    audit.record(
        session,
        actor,
        "award.record",
        "award",
        award.id,
        after={
            "run_id": run.id,
            "tariff": tariff_inr_per_kwh,
            "capacity_mw": capacity_mw,
            "award_date": award_date.isoformat(),
            "inputs_hash": baseline["run"]["inputs_hash"],
            "requirement_version_id": baseline["requirements"]["version_id"],
        },
        tender_id=tender.id,
    )
    return award


def dump_award(a: Award) -> dict[str, Any]:
    return {
        "id": a.id,
        "tender_id": a.tender_id,
        "run_id": a.run_id,
        "scenario_id": a.scenario_id,
        "input_version_id": a.input_version_id,
        "requirement_version_id": a.requirement_version_id,
        "awarded_tariff_inr_per_kwh": a.awarded_tariff_inr_per_kwh,
        "awarded_capacity_mw": a.awarded_capacity_mw,
        "award_date": a.award_date.isoformat(),
        "letter_reference": a.letter_reference,
        "status": a.status,
        "note": a.note,
        "baseline": a.baseline,
        "created_at": a.created_at.isoformat(),
        "created_by": a.created_by,
    }


def get_award(session: Session, actor: Actor, award_id: str) -> Award:
    a = session.get(Award, award_id)
    if a is None or a.organization_id != actor.organization_id:
        raise NotFound("award")
    tenders.get(session, actor, a.tender_id)
    return a


def list_awards(session: Session, actor: Actor, tender_id: str) -> list[Award]:
    tenders.get(session, actor, tender_id)
    return list(
        session.scalars(select(Award).where(Award.tender_id == tender_id, Award.organization_id == actor.organization_id).order_by(Award.created_at.desc()))
    )


# ----------------------------------------------------------------------- DPR generation


def _v(key: str, label: str, value: Any, unit: str | None, path: str, run_id: str) -> dict[str, Any]:
    return {"key": key, "label": label, "value": value, "unit": unit, "source": {"run_id": run_id, "path": path}}


def generate_sections(award: Award) -> list[dict[str, Any]]:
    """The DPR skeleton from the frozen baseline. Every value carries its source path in the
    run so it can be re-read and checked (`trace`)."""
    b = award.baseline
    rid = award.run_id
    fin = b["result"].get("finance") or {}
    per_year = (b["result"].get("term") or {}).get("per_year") or []
    y1 = per_year[0] if per_year else {}
    cert = (b["result"].get("term") or {}).get("certification_year1") or {}
    sections: list[dict[str, Any]] = []
    sections.append(
        {
            "key": "project_overview",
            "title": "1. Project overview",
            "body": f"{b['tender']['name']} procured by {b['tender']['procurer'] or 'the procurer'}"
            + (f" (reference {b['tender']['reference']})" if b["tender"].get("reference") else "")
            + f". The award follows the approved run {rid[:8]} on scenario '{b['scenario']['name']}' (inputs {b['run']['inputs_hash'][:12] if b['run']['inputs_hash'] else '-'}).",
            "values": [
                _v("awarded_capacity_mw", "Awarded capacity", award.awarded_capacity_mw, "MW", "award.awarded_capacity_mw", rid),
                _v("awarded_tariff", "Awarded tariff", award.awarded_tariff_inr_per_kwh, "INR/kWh", "award.awarded_tariff_inr_per_kwh", rid),
                _v("award_date", "Award date", award.award_date.isoformat(), None, "award.award_date", rid),
                _v("letter_reference", "Letter of award", award.letter_reference, None, "award.letter_reference", rid),
                _v(
                    "contracted_capacity_mw",
                    "Contracted capacity in the model",
                    b["inputs"].get("contracted_capacity_mw"),
                    "MW",
                    "inputs.project.tender.contracted_capacity_mw",
                    rid,
                ),
                _v("run_tariff", "Tariff in the approved run", b["result"].get("tariff"), "INR/kWh", "result.tariff", rid),
            ],
        }
    )
    tech_values = []
    for i, m in enumerate((b["inputs"].get("supply") or {}).get("modules") or []):
        for cap_key, unit in (("mwac", "MWac"), ("mwp_dc", "MWp"), ("installed_mw", "MW"), ("power_mw", "MW"), ("energy_mwh", "MWh"), ("capacity_mw", "MW")):
            if m.get(cap_key) is not None:
                tech_values.append(
                    _v(
                        f"module_{i}_{cap_key}",
                        f"{m.get('name')} ({m.get('kind')}) {cap_key}",
                        m.get(cap_key),
                        unit,
                        f"inputs.supply.modules[{i}].{cap_key}",
                        rid,
                    )
                )
    sections.append(
        {
            "key": "technical_configuration",
            "title": "2. Technical configuration",
            "body": "Supply modules, capacities and interconnection as frozen in the approved run's inputs. Loss chains and profiles are in the scenario's supply configuration.",
            "values": tech_values,
        }
    )
    sections.append(
        {
            "key": "energy_and_dispatch",
            "title": "3. Energy yield and dispatch",
            "body": f"Year-1 dispatch from the {b['run'].get('solver') or 'dispatch'} solution; years solved {', '.join(str(y) for y in (b['result'].get('term') or {}).get('years_solved') or [])}; independent validation of year 1: {cert.get('status') or 'not run'}.",
            "values": [
                _v("ppa_mwh_y1", "Year-1 energy to the PPA", y1.get("ppa_mwh"), "MWh", "result.term.per_year[0].ppa_mwh", rid),
                _v("cuf_y1", "Year-1 annual CUF", y1.get("annual_cuf"), "fraction", "result.term.per_year[0].annual_cuf", rid),
                _v("curtailed_y1", "Year-1 curtailed", y1.get("re_curtailed_mwh"), "MWh", "result.term.per_year[0].re_curtailed_mwh", rid),
                _v("purchases_y1", "Year-1 market purchases", y1.get("iex_purchase_mwh"), "MWh", "result.term.per_year[0].iex_purchase_mwh", rid),
                _v("penalty_mwh_y1", "Year-1 penalty energy", y1.get("total_penalty_mwh"), "MWh", "result.term.per_year[0].total_penalty_mwh", rid),
                _v("peak_ok_y1", "Year-1 peak availability met", y1.get("peak_ok"), None, "result.term.per_year[0].peak_ok", rid),
                _v("validation_y1", "Independent validation (year 1)", cert.get("status"), None, "result.term.certification_year1.status", rid),
            ],
        }
    )
    sections.append(
        {
            "key": "financial_model",
            "title": "4. Financial model",
            "body": f"Results of {fin.get('version') or 'the financial model'} at the approved run's tariff. The full formula workbook is linked in the annexures.",
            "values": [
                _v("equity_irr", "Equity IRR", fin.get("equity_irr"), "fraction", "result.finance.equity_irr", rid),
                _v("project_irr", "Project IRR", fin.get("project_irr"), "fraction", "result.finance.project_irr", rid),
                _v("npv_equity_cr", "NPV to equity", fin.get("npv_equity_cr"), "INR crore", "result.finance.npv_equity_cr", rid),
                _v("min_dscr", "Minimum DSCR", fin.get("min_dscr"), "x", "result.finance.min_dscr", rid),
                _v("avg_dscr", "Average DSCR", fin.get("avg_dscr"), "x", "result.finance.avg_dscr", rid),
                _v("total_project_cost_cr", "Total project cost", fin.get("total_project_cost_cr"), "INR crore", "result.finance.total_project_cost_cr", rid),
                _v("debt_cr", "Debt", fin.get("debt_cr"), "INR crore", "result.finance.debt_cr", rid),
                _v("equity_cr", "Equity", fin.get("equity_cr"), "INR crore", "result.finance.equity_cr", rid),
            ],
        }
    )
    req_values = [
        _v(f"req_{r['field_path'].replace('.', '_')}", r["label"], r["value"], r["unit"], f"requirements.items[{i}].value", rid)
        for i, r in enumerate(b["requirements"]["items"])
    ]
    sections.append(
        {
            "key": "tender_obligations",
            "title": "5. Tender obligations",
            "body": (
                f"Requirements as approved in requirement version {b['requirements']['version_no']} at the time of award."
                if b["requirements"]["version_id"]
                else "No approved requirement version existed at the time of award; obligations must be entered from the signed PPA."
            ),
            "values": req_values,
        }
    )
    assum = b["result"].get("assumptions") or {}
    a_values = [
        _v(f"capex_{i}", f"Capex: {c.get('name')}", c.get("amount_inr"), "INR", f"result.assumptions.capex[{i}].amount_inr", rid)
        for i, c in enumerate(assum.get("capex") or [])
    ]
    a_values += [
        _v(f"opex_{i}", f"Opex: {o.get('name')}", o.get("amount_inr_per_year"), "INR/year", f"result.assumptions.opex[{i}].amount_inr_per_year", rid)
        for i, o in enumerate(assum.get("opex") or [])
    ]
    sections.append(
        {
            "key": "assumptions_and_sources",
            "title": "6. Assumptions and their sources",
            "body": "Each assumption's source as recorded on the run: "
            + "; ".join(f"{c.get('name')}: {c.get('source')}" for c in (assum.get("capex") or []))
            + ".",
            "values": a_values,
        }
    )
    risks = [f"{x}" for x in (b["result"].get("binding") or [])]
    if (b["result"].get("term") or {}).get("years_interpolated"):
        risks.append(f"{len(b['result']['term']['years_interpolated'])} contract years were interpolated, not solved")
    sections.append(
        {
            "key": "risks_and_limitations",
            "title": "7. Risks and limitations",
            "body": "\n".join("- " + r for r in risks) or "No binding constraints or limitations reported by the run.",
            "values": [],
        }
    )
    sections.append(
        {
            "key": "annexures",
            "title": "8. Annexures",
            "body": f"A. Approved run {rid}: result.json artifact. B. Financial model workbook (formulas) if exported. C. Scenario input version {b['scenario']['input_version_no']} ({b['run']['inputs_hash']}). D. Rules version {b['run']['rules_version']}.",
            "values": [],
        }
    )
    return sections


def dump_workspace(ws: DprWorkspace, version: DprVersion | None) -> dict[str, Any]:
    return {
        "id": ws.id,
        "award_id": ws.award_id,
        "tender_id": ws.tender_id,
        "title": ws.title,
        "status": ws.status,
        "current_version_no": ws.current_version_no,
        "revision": ws.revision,
        "updated_at": ws.updated_at.isoformat() if ws.updated_at else None,
        "updated_by": ws.updated_by,
        "version": dump_version(version) if version else None,
    }


def dump_version(v: DprVersion) -> dict[str, Any]:
    return {
        "id": v.id,
        "version_no": v.version_no,
        "sections": v.sections,
        "change_note": v.change_note,
        "changed_sections": v.changed_sections,
        "created_at": v.created_at.isoformat(),
        "created_by": v.created_by,
    }


def create_workspace(session: Session, actor: Actor, award_id: str) -> tuple[DprWorkspace, DprVersion]:
    actor.require("dpr.edit")
    award = get_award(session, actor, award_id)
    if session.scalar(select(DprWorkspace).where(DprWorkspace.award_id == award.id)) is not None:
        raise ValidationFailed("a DPR workspace already exists for this award")
    ws = DprWorkspace(
        organization_id=actor.organization_id,
        created_by=actor.user_id,
        award_id=award.id,
        tender_id=award.tender_id,
        title=f"DPR: {award.baseline['tender']['name']}",
        status="draft",
        current_version_no=1,
        revision=1,
        updated_at=_now(),
        updated_by=actor.user_id,
    )
    session.add(ws)
    session.flush()
    v = DprVersion(
        organization_id=actor.organization_id,
        created_by=actor.user_id,
        workspace_id=ws.id,
        version_no=1,
        sections=generate_sections(award),
        change_note="generated from the award baseline",
        changed_sections=[s["key"] for s in generate_sections(award)],
    )
    session.add(v)
    session.flush()
    audit.record(session, actor, "dpr.create", "dpr_workspace", ws.id, after={"award_id": award.id, "run_id": award.run_id}, tender_id=award.tender_id)
    return ws, v


def get_workspace(session: Session, actor: Actor, workspace_id: str) -> DprWorkspace:
    ws = session.get(DprWorkspace, workspace_id)
    if ws is None or ws.organization_id != actor.organization_id:
        raise NotFound("dpr workspace")
    tenders.get(session, actor, ws.tender_id)
    return ws


def workspace_for_award(session: Session, actor: Actor, award_id: str) -> DprWorkspace | None:
    get_award(session, actor, award_id)
    return session.scalar(select(DprWorkspace).where(DprWorkspace.award_id == award_id))


def versions(session: Session, actor: Actor, workspace_id: str) -> list[DprVersion]:
    ws = get_workspace(session, actor, workspace_id)
    return list(session.scalars(select(DprVersion).where(DprVersion.workspace_id == ws.id).order_by(DprVersion.version_no)))


def current_version(session: Session, ws: DprWorkspace) -> DprVersion:
    v = session.scalar(select(DprVersion).where(DprVersion.workspace_id == ws.id, DprVersion.version_no == ws.current_version_no))
    if v is None:
        raise NotFound("dpr version")
    return v


def save_version(
    session: Session, actor: Actor, workspace_id: str, *, expected_revision: int, sections: list[dict[str, Any]], change_note: str = ""
) -> DprVersion:
    actor.require("dpr.edit")
    ws = get_workspace(session, actor, workspace_id)
    if ws.status == "issued":
        raise ValidationFailed("an issued DPR is final; reopen it (status in_review) to edit")
    if ws.revision != expected_revision:
        raise Conflict(f"DPR was changed by someone else (revision {ws.revision})", current_revision=ws.revision, conflicts=[])
    award = get_award(session, actor, ws.award_id)
    baseline_sections = {s["key"]: s for s in generate_sections(award)}
    current = current_version(session, ws)
    current_by_key = {s["key"]: s for s in current.sections}
    stored: list[dict[str, Any]] = []
    bad: list[str] = []
    seen: set[str] = set()
    for s in sections:
        key = str(s.get("key") or "")
        if key not in baseline_sections or key in seen:
            raise ValidationFailed(f"unknown or duplicate section {key!r}")
        seen.add(key)
        base = baseline_sections[key]
        base_values = {v["key"]: v for v in base["values"]}
        for v in s.get("values") or []:
            bv = base_values.get(v.get("key"))
            if bv is None or v.get("value") != bv["value"]:
                bad.append(f"{key}.{v.get('key')}")
        stored.append({"key": key, "title": base["title"], "body": str(s.get("body") or "")[:20000], "values": base["values"]})
    if bad:
        raise ValidationFailed("traced values come from the award baseline and cannot be edited: " + ", ".join(bad) + ". Record a new award to change them.")
    if seen != set(baseline_sections):
        raise ValidationFailed("every section must be present: " + ", ".join(sorted(set(baseline_sections) - seen)))
    changed = [s["key"] for s in stored if s["body"] != (current_by_key.get(s["key"]) or {}).get("body")]
    ws.current_version_no += 1
    ws.revision += 1
    ws.updated_at = _now()
    ws.updated_by = actor.user_id
    v = DprVersion(
        organization_id=actor.organization_id,
        created_by=actor.user_id,
        workspace_id=ws.id,
        version_no=ws.current_version_no,
        sections=stored,
        change_note=change_note[:2000],
        changed_sections=changed,
    )
    session.add(v)
    session.flush()
    audit.record(
        session,
        actor,
        "dpr.version",
        "dpr_workspace",
        ws.id,
        object_version=v.version_no,
        after={"changed_sections": changed, "change_note": change_note[:200]},
        tender_id=ws.tender_id,
    )
    return v


def set_status(session: Session, actor: Actor, workspace_id: str, *, expected_revision: int, status: str) -> DprWorkspace:
    ws = get_workspace(session, actor, workspace_id)
    if status not in WORKSPACE_STATUSES:
        raise ValidationFailed(f"status must be one of {', '.join(WORKSPACE_STATUSES)}")
    actor.require("bid.approve" if status == "issued" else "dpr.edit")
    if ws.revision != expected_revision:
        raise Conflict(f"DPR was changed by someone else (revision {ws.revision})", current_revision=ws.revision, conflicts=[])
    before = ws.status
    ws.status = status
    ws.revision += 1
    ws.updated_at = _now()
    ws.updated_by = actor.user_id
    session.flush()
    audit.record(session, actor, "dpr.status", "dpr_workspace", ws.id, before={"status": before}, after={"status": status}, tender_id=ws.tender_id)
    return ws


def trace(session: Session, actor: Actor, workspace_id: str) -> dict[str, Any]:
    """Every traced value re-read from its source: the award row, the run's stored result
    and the frozen input version. `matches` is false if anything drifted."""
    ws = get_workspace(session, actor, workspace_id)
    award = get_award(session, actor, ws.award_id)
    run = session.get(Run, award.run_id)
    inputs_version = session.get(ScenarioInputVersion, award.input_version_id)
    req_items = award.baseline["requirements"]["items"]
    live_reqs: dict[str, Any] = {}
    if award.requirement_version_id:
        rv = session.get(RequirementVersion, award.requirement_version_id)
        if rv is not None:
            live_reqs = {r.field_path: r.value for r in session.scalars(select(Requirement).where(Requirement.requirement_version_id == rv.id))}
    root = {
        "award": {
            "awarded_capacity_mw": award.awarded_capacity_mw,
            "awarded_tariff_inr_per_kwh": award.awarded_tariff_inr_per_kwh,
            "award_date": award.award_date.isoformat(),
            "letter_reference": award.letter_reference,
        },
        "result": run.result if run else None,
        "metrics": run.metrics if run else None,
        "inputs": inputs_version.inputs if inputs_version else None,
        "requirements": {"items": [{"value": live_reqs.get(i["field_path"], i["value"])} for i in req_items]},
    }
    v = current_version(session, ws)
    rows = []
    for s in v.sections:
        for val in s["values"]:
            current = get_path(root, val["source"]["path"])
            rows.append(
                {
                    "section": s["key"],
                    "key": val["key"],
                    "label": val["label"],
                    "value": val["value"],
                    "unit": val["unit"],
                    "source": val["source"],
                    "current": current,
                    "matches": _same(current, val["value"]),
                }
            )
    return {
        "workspace_id": ws.id,
        "version_no": v.version_no,
        "award_id": award.id,
        "run_id": award.run_id,
        "run_status": run.status if run else None,
        "run_stale": run.stale if run else None,
        "input_version_id": award.input_version_id,
        "inputs_hash": award.baseline["run"]["inputs_hash"],
        "requirement_version_id": award.requirement_version_id,
        "values": rows,
        "all_match": all(r["matches"] for r in rows),
    }


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, int | float) and isinstance(b, int | float) and not isinstance(a, bool) and not isinstance(b, bool):
        return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))
    return a == b


# ------------------------------------------------------------------------------- exports


def _fmt(v: Any, unit: str | None) -> str:
    if v is None:
        return "—"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, float):
        if unit == "fraction":
            return f"{v * 100:.2f} %"
        return f"{v:,.4f}".rstrip("0").rstrip(".") + (f" {unit}" if unit else "")
    if isinstance(v, int):
        return f"{v:,}" + (f" {unit}" if unit else "")
    return f"{v}" + (f" {unit}" if unit else "")


def build_docx(ws: DprWorkspace, award: Award, version: DprVersion, *, workbook: RunArtifact | None) -> bytes:
    doc = Document()
    style = doc.styles["Normal"]
    style.font.size = Pt(10)
    doc.add_heading(ws.title, 0)
    meta = doc.add_table(rows=0, cols=2)
    meta.style = "Light Grid Accent 1"
    for k, v in (
        ("DPR version", f"{version.version_no} ({version.created_at.strftime('%Y-%m-%d %H:%M UTC')})"),
        ("Status", ws.status),
        ("Award", f"{award.awarded_capacity_mw:g} MW at {award.awarded_tariff_inr_per_kwh} INR/kWh on {award.award_date.isoformat()}"),
        ("Letter of award", award.letter_reference or "—"),
        ("Approved source run", award.run_id),
        ("Inputs hash", award.baseline["run"]["inputs_hash"] or "—"),
        ("Rules version", award.baseline["run"]["rules_version"] or "—"),
        ("Requirement version", award.baseline["requirements"]["version_id"] or "none approved"),
        ("Financial model workbook", f"{workbook.filename} (sha256 {workbook.sha256})" if workbook else "not exported"),
    ):
        row = meta.add_row().cells
        row[0].text, row[1].text = k, v
    doc.add_paragraph(
        "Every figure in this report carries the run id and result path it was read from (see the trace table in the annexure). Figures cannot be edited in the DPR; a change requires a new award from a new approved run."
    )
    for s in version.sections:
        doc.add_heading(s["title"], 1)
        for para in str(s["body"]).split("\n\n"):
            if para.strip():
                doc.add_paragraph(para.strip())
        if s["values"]:
            t = doc.add_table(rows=1, cols=3)
            t.style = "Light Grid Accent 1"
            t.rows[0].cells[0].text, t.rows[0].cells[1].text, t.rows[0].cells[2].text = "Item", "Value", "Source"
            for v in s["values"]:
                r = t.add_row().cells
                r[0].text, r[1].text, r[2].text = str(v["label"]), _fmt(v["value"], v["unit"]), f"run {v['source']['run_id'][:8]} · {v['source']['path']}"
    doc.add_heading("Trace", 1)
    doc.add_paragraph(
        f"Source run {award.run_id} ({award.baseline['run']['kind']}, {award.baseline['run']['status']}), scenario '{award.baseline['scenario']['name']}' input version {award.baseline['scenario']['input_version_no']}, frozen {award.baseline['frozen_at']}."
    )
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def docx_to_pdf(docx_bytes: bytes, timeout: int = 180) -> bytes:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if soffice is None:
        raise ValidationFailed("PDF export needs LibreOffice (soffice) on the server")
    with tempfile.TemporaryDirectory() as td:
        src = pathlib.Path(td) / "dpr.docx"
        src.write_bytes(docx_bytes)
        subprocess.run(
            [soffice, "--headless", "--convert-to", "pdf", "--outdir", td, str(src)],
            check=True,
            capture_output=True,
            timeout=timeout,
            env={"HOME": td, "PATH": "/usr/bin:/bin"},
        )
        out = pathlib.Path(td) / "dpr.pdf"
        if not out.exists():
            raise ValidationFailed("LibreOffice produced no PDF")
        return out.read_bytes()


def export(session: Session, storage: LocalStorage, actor: Actor, workspace_id: str, fmt: str) -> DprArtifact:
    actor.require("dpr.edit")
    if fmt not in ("docx", "pdf"):
        raise ValidationFailed("format must be docx or pdf")
    ws = get_workspace(session, actor, workspace_id)
    award = get_award(session, actor, ws.award_id)
    version = current_version(session, ws)
    workbook = session.scalar(
        select(RunArtifact).where(RunArtifact.run_id == award.run_id, RunArtifact.kind == "financial_model_xlsx").order_by(RunArtifact.created_at.desc())
    )
    data = build_docx(ws, award, version, workbook=workbook)
    content_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    if fmt == "pdf":
        data = docx_to_pdf(data)
        content_type = "application/pdf"
    filename = f"dpr-{award.tender_id[:8]}-v{version.version_no}.{fmt}"
    stored = storage.put(actor.organization_id, "dpr", filename, data)
    art = DprArtifact(
        organization_id=actor.organization_id,
        created_by=actor.user_id,
        workspace_id=ws.id,
        version_no=version.version_no,
        kind=fmt,
        filename=filename,
        content_type=content_type,
        sha256=hashlib.sha256(data).hexdigest(),
        size_bytes=len(data),
        storage_key=stored.key,
        linked_workbook_sha256=workbook.sha256 if workbook else None,
    )
    session.add(art)
    session.flush()
    audit.record(
        session,
        actor,
        "dpr.export",
        "dpr_workspace",
        ws.id,
        object_version=version.version_no,
        after={"artifact_id": art.id, "kind": fmt, "sha256": art.sha256, "linked_workbook_sha256": art.linked_workbook_sha256},
        tender_id=ws.tender_id,
    )
    return art


def artifacts(session: Session, actor: Actor, workspace_id: str) -> list[DprArtifact]:
    ws = get_workspace(session, actor, workspace_id)
    return list(session.scalars(select(DprArtifact).where(DprArtifact.workspace_id == ws.id).order_by(DprArtifact.created_at.desc())))


def dump_artifact(a: DprArtifact) -> dict[str, Any]:
    return {
        "id": a.id,
        "workspace_id": a.workspace_id,
        "version_no": a.version_no,
        "kind": a.kind,
        "filename": a.filename,
        "content_type": a.content_type,
        "sha256": a.sha256,
        "size_bytes": a.size_bytes,
        "linked_workbook_sha256": a.linked_workbook_sha256,
        "created_at": a.created_at.isoformat(),
        "created_by": a.created_by,
    }
