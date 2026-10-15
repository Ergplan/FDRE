"""The concise, evidence-linked tender summary, built deterministically from a requirement
version: every line cites the requirement it comes from (and so its page and excerpt), the
missing required fields are listed, contradictions come from the version's conflicts and
bid risks from unsupported or unreviewed rules and from values without located evidence."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from fdre_platform.models import RequirementVersion
from fdre_platform.rules.catalog import BY_PATH, SUMMARY_GROUPS
from fdre_platform.rules.compile import compile_rules

from . import requirements


def build(session: Session, version: RequirementVersion) -> dict[str, Any]:
    rows = requirements.rows_of(session, version)
    dicts = [requirements._req_dict(r) for r in rows]
    rules = compile_rules(dicts)
    groups: dict[str, list[dict[str, Any]]] = {g: [] for g, _ in SUMMARY_GROUPS}
    groups["other"] = []
    for d in dicts:
        if d["review_state"] == "rejected":
            continue
        fdef = BY_PATH.get(d["field_path"])
        group = fdef.summary_group if fdef else "other"
        groups.setdefault(group, []).append(
            {
                "requirement_id": d["id"], "field_path": d["field_path"], "label": d["label"], "value": d["value"], "unit": d["unit"],
                "provenance": d["provenance"], "confidence": d["confidence"], "review_state": d["review_state"], "change_kind": d["change_kind"],
                "evidence": d["evidence"], "effective_date": d["effective_date"],
            }
        )
    missing = [{"field_path": p, "label": BY_PATH[p].label} for p in rules["required_missing"]]
    contradictions = [{"field_path": c["field_path"], "label": BY_PATH[c["field_path"]].label if c["field_path"] in BY_PATH else c["field_path"], "values": c["values"], "evidence": c["evidence"]} for c in version.conflicts]
    risks: list[dict[str, Any]] = []
    for r in rules["rules"]:
        if not r["supported"]:
            risks.append({"kind": "unsupported_rule", "field_path": r["field_path"], "label": r["label"], "detail": r["reason"]})
    for d in dicts:
        if d["value"] is not None and d["review_state"] != "rejected":
            if d["provenance"] in ("inferred", "defaulted"):
                risks.append({"kind": "unverified_value", "field_path": d["field_path"], "label": d["label"], "detail": f"value is {d['provenance']}, not read from the document"})
            elif not (d["evidence"] and d["evidence"].get("page") and d["evidence"].get("excerpt")):
                risks.append({"kind": "no_located_evidence", "field_path": d["field_path"], "label": d["label"], "detail": "no page and excerpt behind the value"})
    return {
        "requirement_version_id": version.id,
        "version_no": version.version_no,
        "status": version.status,
        "groups": [{"key": g, "title": t, "items": groups.get(g, [])} for g, t in SUMMARY_GROUPS] + ([{"key": "other", "title": "Other extracted items", "items": groups["other"]}] if groups["other"] else []),
        "missing_information": missing,
        "contradictions": contradictions,
        "bid_risks": risks,
        "rules": rules,
        "narrative_source": None,
    }
