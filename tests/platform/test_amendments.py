"""Day 2 gate: a base tender and an amendment produce an accurate field diff, an updated
draft requirement version, stale-result flags and actionable notifications, while the
previous baseline is preserved. tender_engine answers from a recorded fixture here
(source "fixture"); the adapter contract is the one inspected in that repository."""

from __future__ import annotations

import io

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from fdre_platform.integrations.tender_engine import candidates_from_view

ORG_FIXTURE = "nhpc_fdre_ii"


def _pdf(title: str, lines: list[str]) -> bytes:
    import fitz  # pymupdf

    doc = fitz.open()
    for i, chunk in enumerate([lines[i : i + 12] for i in range(0, len(lines), 12)] or [[]]):
        page = doc.new_page()
        page.insert_text((72, 72), f"{title} - page {i + 1}", fontsize=14)
        y = 110
        for line in chunk:
            page.insert_text((72, y), line, fontsize=10)
            y += 18
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


BASE_PDF = _pdf(
    "NHPC FDRE Tranche-II RfS",
    ["NHPC Limited invites bids for supply of 1200 MW Firm and Dispatchable power", "The PPA shall be valid for a period of 25 (twenty five) years"],
)
AMEND_PDF = _pdf(
    "Amendment-01", ["The last date for bid submission stands extended to 05.04.2025", "the lower limit of the annual CUF band is revised to -20%"]
)


def _setup(client, seed, as_user, worker):
    """A tender linked to the fixture, with two members, a scenario and a completed run."""
    import fdre_enterprise_engine as E

    acme = seed["acme"]
    bidder = as_user("bidder@acme.test")
    tender = client.post(
        f"/api/v1/orgs/{acme.id}/tenders",
        json={"name": "NHPC FDRE Tranche-II", "procurer": "NHPC", "tender_family": "fdre", "attributes": {"engine_fixture": ORG_FIXTURE}},
        headers=bidder,
    ).json()
    client.post(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/members", json={"email": "eng@acme.test"}, headers=bidder)
    project = E.default_fdre2_project()
    project.finance.hard_compliance_required = False
    inputs = {"project": E.project_to_dict(project), "run_options": {"years_mode": "fast"}, "settings": {"tenderProcurementMw": 1200}}
    scenario = client.post(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/scenarios", json={"name": "Base", "inputs": inputs}, headers=bidder).json()
    run = client.post(f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/runs", json={"kind": "evaluate"}, headers=bidder).json()
    assert worker.run_once()
    run = client.get(f"/api/v1/orgs/{acme.id}/runs/{run['id']}?include_result=false", headers=bidder).json()
    assert run["status"] == "succeeded" and run["stale"] is False
    return acme, bidder, tender, scenario, run


def _upload(client, acme, headers, tender_id, name, data, **form):
    return client.post(
        f"/api/v1/orgs/{acme.id}/tenders/{tender_id}/documents",
        files={"file": (name, data, "application/pdf")},
        data={k: str(v) for k, v in form.items()},
        headers=headers,
    )


def test_view_mapping_flattens_records_and_keeps_evidence():
    import json
    import pathlib

    fx = json.loads((pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "tender_engine" / f"{ORG_FIXTURE}.json").read_text())
    cands = candidates_from_view(fx["view"]["1"], source="fixture")
    by_path = {c.field_path: c for c in cands}
    assert by_path["sector.power.fdre.demand_profile_structured.cuf_band_lower_pct"].value == 85
    assert by_path["sector.power.common.bess_charging_rule.re_only"].value is True
    ev = by_path["sector.power.fdre.assured_availability_percent"].evidence
    assert ev["page"] == 180 and "90%" in ev["excerpt"] and ev["document_version"] == 1
    assert all(c.source == "fixture" for c in cands)


def test_base_tender_then_amendment_flow(client, seed, as_user, worker, session_factory):
    acme, bidder, tender, scenario, run = _setup(client, seed, as_user, worker)
    eng = as_user("eng@acme.test")
    org = acme.id

    # 1. Base document: stored, pushed to the (fixture) engine, extracted into requirement version 1.
    r = _upload(client, acme, bidder, tender["id"], "RfS.pdf", BASE_PDF, kind="original", issued_on="2025-01-20")
    assert r.status_code == 201, r.text
    base = r.json()
    assert base["document"]["publication_order"] == 1 and base["document"]["kind"] == "original"
    assert base["extractor"] == "tender_engine:fixture"  # labelled fixture-backed
    v1 = base["requirement_version"]
    assert v1["version_no"] == 1 and v1["status"] == "draft" and base["impact"] is None
    kinds = {c["field_path"]: c["kind"] for c in base["changes"]}
    assert all(k == "added" for k in kinds.values()) and "sector.power.fdre.assured_availability_percent" in kinds

    # Duplicate bytes are refused with the existing document, whatever the filename.
    dup = _upload(client, acme, bidder, tender["id"], "RfS-copy.pdf", BASE_PDF, kind="original")
    assert dup.status_code == 409 and dup.json()["document_id"] == base["document"]["id"]

    # Every requirement carries evidence, provenance and review state; the summary lists gaps.
    current = client.get(f"/api/v1/orgs/{org}/tenders/{tender['id']}/requirements", headers=eng).json()
    rows = current["version"]["requirements"]
    assert all(row["evidence"]["page"] and row["evidence"]["excerpt"] for row in rows if row["value"] is not None)
    assert {row["provenance"] for row in rows} == {"extracted"} and {row["review_state"] for row in rows} == {"unreviewed"}
    summary = current["summary"]
    missing = {m["field_path"] for m in summary["missing_information"]}
    assert "core.key_dates.bid_submission_deadline" not in missing  # present
    assert summary["rules"]["certifiable"] is False and any("unreviewed" in b for b in summary["rules"]["blocking"])
    groups = {g["key"]: g for g in summary["groups"]}
    assert any(i["field_path"] == "sector.power.fdre.assured_availability_percent" for i in groups["delivery"]["items"])

    # Approval needs review: refuse, then accept every row and approve -> rule set 1, inputs auto-applied.
    vid = v1["id"]
    assert client.post(f"/api/v1/orgs/{org}/requirement-versions/{vid}/approve", headers=bidder).status_code == 422
    for row in rows:
        assert client.post(f"/api/v1/orgs/{org}/requirements/{row['id']}/review", json={"decision": "accept"}, headers=eng).status_code == 200
    approved = client.post(f"/api/v1/orgs/{org}/requirement-versions/{vid}/approve", headers=bidder).json()
    assert approved["version"]["status"] == "approved" and approved["rule_set"]["version_no"] == 1
    rules = {r["rule_id"]: r for r in approved["rule_set"]["rules"]}
    assert rules["peak_availability:sector.power.fdre.assured_availability_percent"]["engine_value"] == 0.9
    assert rules["cuf_band:sector.power.fdre.demand_profile_structured.cuf_band_lower_pct"]["engine_value"] == pytest.approx(0.15)
    assert approved["rule_set"]["certifiable"] is True, approved["rule_set"]["blocking"]
    # Locked: a row of the approved version cannot be changed, in the API or in the database.
    assert client.post(f"/api/v1/orgs/{org}/requirements/{rows[0]['id']}/review", json={"decision": "reject"}, headers=eng).status_code == 422
    with session_factory() as s, pytest.raises(DBAPIError, match="locked"):
        s.execute(text("update requirement set value='1'::jsonb where id=:id"), {"id": rows[0]["id"]})
        s.commit()

    # A second run on the current inputs, so there is a fresh, non-stale result to invalidate.
    run2 = client.post(f"/api/v1/orgs/{org}/scenarios/{scenario['id']}/runs", json={"kind": "evaluate"}, headers=bidder).json()
    assert worker.run_once()
    run2 = client.get(f"/api/v1/orgs/{org}/runs/{run2['id']}?include_result=false", headers=bidder).json()
    assert run2["status"] == "succeeded" and run2["stale"] is False

    # 2. The amendment arrives.
    r = _upload(
        client,
        acme,
        bidder,
        tender["id"],
        "Amendment-01.pdf",
        AMEND_PDF,
        kind="amendment",
        issued_on="2025-03-01",
        effective_on="2025-03-01",
        supersedes_document_id=base["document"]["id"],
        summary_of_change="Amendment-01: deadline extended, CUF band and green sourcing revised, ceiling tariff deleted",
    )
    assert r.status_code == 201, r.text
    am = r.json()
    assert am["document"]["publication_order"] == 2 and am["document"]["supersedes_document_id"] == base["document"]["id"]
    v2 = am["requirement_version"]
    assert v2["version_no"] == 2 and v2["status"] == "draft" and v2["previous_version_id"] == vid
    # Accurate field diff: changed, restated and removed, with old and new values and evidence.
    diff = {c["field_path"]: c for c in am["changes"]}
    assert (
        diff["core.key_dates.bid_submission_deadline"]["kind"] == "changed"
        and diff["core.key_dates.bid_submission_deadline"]["old_value"] == "2025-03-15"
        and diff["core.key_dates.bid_submission_deadline"]["new_value"] == "2025-04-05"
    )
    assert (
        diff["sector.power.fdre.demand_profile_structured.cuf_band_lower_pct"]["kind"] == "changed"
        and diff["sector.power.fdre.demand_profile_structured.cuf_band_lower_pct"]["old_value"] == 85
        and diff["sector.power.fdre.demand_profile_structured.cuf_band_lower_pct"]["new_value"] == 80
    )
    assert diff["sector.power.fdre.demand_profile_structured.external_sourcing_max_pct"]["kind"] == "changed"
    assert diff["sector.power.fdre.assured_availability_percent"]["kind"] == "restated"
    assert (
        diff["sector.power.common.tariff_ceiling_inr_per_kwh"]["kind"] == "removed"
        and diff["sector.power.common.tariff_ceiling_inr_per_kwh"]["old_value"] == 4.5
    )
    assert (
        diff["core.key_dates.bid_submission_deadline"]["new_evidence"]["page"] == 1
        and "05.04.2025" in diff["core.key_dates.bid_submission_deadline"]["new_evidence"]["excerpt"]
    )
    assert "sector.power.common.ppa_tenure_years" not in diff  # untouched fields are not reported as changes

    # Impact: affected inputs, constraints, runs, reports and the owner; stale flags on completed runs.
    impact = am["impact"]
    assert impact["status"] == "open" and impact["owner_user_id"] == acme.users["bidder"]
    changes = {c["field_path"]: c for c in impact["changes"]}
    assert "sector.power.fdre.assured_availability_percent" not in changes  # restated: no impact
    cuf = changes["sector.power.fdre.demand_profile_structured.cuf_band_lower_pct"]
    assert cuf["affected_inputs"] == ["project.tender.cuf_lower_tolerance"] and cuf["affected_constraints"] == ["annual_cuf"]
    assert set(cuf["affected_run_ids"]) == {run["id"], run2["id"]} and cuf["affected_report_ids"] and cuf["needs_review"] is False
    deadline = changes["core.key_dates.bid_submission_deadline"]
    assert deadline["affected_inputs"] == [] and deadline["needs_review"] is True
    for rid in (run["id"], run2["id"]):
        stale = client.get(f"/api/v1/orgs/{org}/runs/{rid}?include_result=false", headers=bidder).json()
        assert stale["stale"] is True and "Amendment-01.pdf" in stale["stale_reason"]
        assert stale["status"] == "succeeded"  # the completed run itself is untouched

    # The previous baseline is preserved and still approved; version 2 is the working draft.
    versions = client.get(f"/api/v1/orgs/{org}/tenders/{tender['id']}/requirements/versions", headers=eng).json()
    assert [(v["version_no"], v["status"]) for v in versions] == [(1, "approved"), (2, "draft")]
    current = client.get(f"/api/v1/orgs/{org}/tenders/{tender['id']}/requirements", headers=eng).json()
    assert current["approved"]["version_no"] == 1 and current["version"]["version_no"] == 2
    v2rows = {r["field_path"]: r for r in current["version"]["requirements"]}
    assert (
        v2rows["sector.power.common.ppa_tenure_years"]["change_kind"] == "unchanged"
        and v2rows["sector.power.common.ppa_tenure_years"]["review_state"] == "accepted"
    )
    assert (
        v2rows["core.key_dates.bid_submission_deadline"]["change_kind"] == "changed"
        and v2rows["core.key_dates.bid_submission_deadline"]["review_state"] == "unreviewed"
    )
    assert v2rows["core.key_dates.bid_submission_deadline"]["alternatives"][0]["value"] == "2025-03-15"
    assert (
        v2rows["sector.power.common.tariff_ceiling_inr_per_kwh"]["value"] is None
        and v2rows["sector.power.common.tariff_ceiling_inr_per_kwh"]["change_kind"] == "removed"
    )

    # Actionable notifications and tasks for the tender's members.
    for headers, who in ((bidder, "bidder"), (eng, "eng")):
        notes = client.get(f"/api/v1/orgs/{org}/notifications?unread_only=true", headers=headers).json()
        assert any(n["kind"] == "amendment" and n["object_id"] == impact["id"] for n in notes), who
    tasks = client.get(f"/api/v1/orgs/{org}/tasks?tender_id={tender['id']}", headers=bidder).json()
    titles = [t["title"] for t in tasks]
    assert any("Bid submission deadline" in t for t in titles) and any("Approve requirement version" in t for t in titles)
    assert all(t["assignee_user_id"] for t in tasks)
    # Uploading the same amendment again does not duplicate notifications or tasks.
    assert _upload(client, acme, bidder, tender["id"], "Amendment-01-again.pdf", AMEND_PDF, kind="amendment").status_code == 409
    assert len(client.get(f"/api/v1/orgs/{org}/tasks?tender_id={tender['id']}", headers=bidder).json()) == len(tasks)

    # 3. Review and approve version 2: unambiguous mapped changes update the draft scenario; version 1 is superseded.
    for row in v2rows.values():
        if row["review_state"] == "unreviewed" and row["value"] is not None:
            assert client.post(f"/api/v1/orgs/{org}/requirements/{row['id']}/review", json={"decision": "accept"}, headers=eng).status_code == 200
    approved2 = client.post(f"/api/v1/orgs/{org}/requirement-versions/{v2['id']}/approve", headers=bidder).json()
    assert approved2["rule_set"]["version_no"] == 2
    assert approved2["applied"] and approved2["applied"][0]["scenario_id"] == scenario["id"]
    updates = approved2["applied"][0]["updates"]
    assert updates["project.tender.cuf_lower_tolerance"] == pytest.approx(0.20) and updates["project.tender.external_green_limit_fraction"] == pytest.approx(
        0.10
    )
    sc = client.get(f"/api/v1/orgs/{org}/scenarios/{scenario['id']}", headers=bidder).json()
    assert sc["revision"] == 2 and sc["current_input_version"]["inputs"]["project"]["tender"]["cuf_lower_tolerance"] == pytest.approx(0.20)
    assert "auto-applied approved requirement version 2" in sc["current_input_version"]["note"]
    versions = client.get(f"/api/v1/orgs/{org}/tenders/{tender['id']}/requirements/versions", headers=eng).json()
    assert [(v["version_no"], v["status"]) for v in versions] == [(1, "superseded"), (2, "approved")]
    impacts = client.get(f"/api/v1/orgs/{org}/tenders/{tender['id']}/amendments", headers=eng).json()
    assert impacts[0]["status"] == "applied"
    # The run snapshot of a rerun now carries the new rules version and the document chain.
    run3 = client.post(f"/api/v1/orgs/{org}/scenarios/{scenario['id']}/runs", json={"kind": "evaluate", "supersedes_run_id": run2["id"]}, headers=bidder).json()
    assert run3["snapshot"]["rules_version"] == "rule_set:2" and len(run3["snapshot"]["documents"]) == 2 and run3["supersedes_run_id"] == run2["id"]

    # Timeline shows the whole story with actors.
    timeline = client.get(f"/api/v1/orgs/{org}/tenders/{tender['id']}/timeline", headers=eng).json()
    actions = [e["action"] for e in timeline]
    for expected in (
        "document.upload",
        "requirement_version.create",
        "requirement.accept",
        "requirement_version.approve",
        "amendment.impact",
        "task.create",
        "amendment.auto_apply",
        "run.launch",
    ):
        assert expected in actions, expected


def test_outsider_cannot_see_documents_or_requirements(client, seed, as_user, worker):
    acme, bidder, tender, _, _ = _setup(client, seed, as_user, worker)
    _upload(client, acme, bidder, tender["id"], "RfS.pdf", BASE_PDF, kind="original")
    outsider = as_user("admin2@other.test")
    other = seed["other"].id
    assert client.get(f"/api/v1/orgs/{other}/tenders/{tender['id']}/documents", headers=outsider).status_code == 404
    assert client.get(f"/api/v1/orgs/{other}/tenders/{tender['id']}/requirements", headers=outsider).status_code == 404
    assert _upload(client, acme, outsider, tender["id"], "x.pdf", AMEND_PDF, kind="amendment").status_code == 404


def test_viewer_cannot_upload_or_review(client, seed, as_user, worker):
    acme, bidder, tender, _, _ = _setup(client, seed, as_user, worker)
    client.post(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/members", json={"email": "viewer@acme.test"}, headers=bidder)
    viewer = as_user("viewer@acme.test")
    assert _upload(client, acme, viewer, tender["id"], "RfS.pdf", BASE_PDF, kind="original").status_code == 403
    base = _upload(client, acme, bidder, tender["id"], "RfS.pdf", BASE_PDF, kind="original").json()
    rows = client.get(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/requirements", headers=viewer).json()["version"]["requirements"]
    assert client.post(f"/api/v1/orgs/{acme.id}/requirements/{rows[0]['id']}/review", json={"decision": "accept"}, headers=viewer).status_code == 403
    assert base["requirement_version"]["version_no"] == 1


def test_correction_needs_evidence_and_keeps_the_original(client, seed, as_user, worker):
    acme, bidder, tender, _, _ = _setup(client, seed, as_user, worker)
    _upload(client, acme, bidder, tender["id"], "RfS.pdf", BASE_PDF, kind="original")
    rows = {
        r["field_path"]: r for r in client.get(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/requirements", headers=bidder).json()["version"]["requirements"]
    }
    row = rows["sector.power.common.min_bid_mw"]
    bad = client.post(
        f"/api/v1/orgs/{acme.id}/requirements/{row['id']}/review", json={"decision": "correct", "value": 100, "evidence": {"page": 14}}, headers=bidder
    )
    assert bad.status_code == 422
    ok = client.post(
        f"/api/v1/orgs/{acme.id}/requirements/{row['id']}/review",
        json={
            "decision": "correct",
            "value": 100,
            "note": "read with the corrigendum",
            "evidence": {"document_id": row["source_document_id"], "page": 14, "excerpt": "minimum bid capacity of 100 MW"},
        },
        headers=bidder,
    ).json()
    assert ok["value"] == 100 and ok["original_value"] == 50 and ok["provenance"] == "user_entered" and ok["review_state"] == "corrected"
