"""Day 7 gate: the three workflows end to end through the API and the worker, including an
amendment that arrives after completed runs and the review/rerun that follows; isolation
across organisations over every organisation-scoped route; recovery from a worker that
dies mid-job and from a process restart; a latency floor on the read endpoints."""

from __future__ import annotations

import importlib.util
import pathlib
import random
import re
import statistics
import time
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import text

from fdre_platform.api.app import create_app
from fdre_platform.models import Job
from fdre_platform.services import jobs


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


_econ = _load("test_economic_workflows")
_amend = _load("test_amendments")


def _wait(client, org, headers, run_id, worker, max_jobs=3):
    for _ in range(max_jobs):
        if not worker.run_once():
            break
        run = client.get(f"/api/v1/orgs/{org}/runs/{run_id}?include_result=false", headers=headers).json()
        if run["status"] not in ("queued", "running"):
            return run
    return client.get(f"/api/v1/orgs/{org}/runs/{run_id}?include_result=false", headers=headers).json()


def test_three_workflows_end_to_end_with_an_amendment_after_completed_runs(client, seed, as_user, worker):
    acme = seed["acme"]
    org = acme.id
    bidder = as_user("bidder@acme.test")
    eng = as_user("eng@acme.test")
    tender = client.post(
        f"/api/v1/orgs/{org}/tenders",
        json={"name": "NHPC FDRE Tranche-II", "procurer": "NHPC", "tender_family": "fdre", "attributes": {"engine_fixture": _amend.ORG_FIXTURE}},
        headers=bidder,
    ).json()
    for email in ("eng@acme.test", "fin@acme.test"):
        client.post(f"/api/v1/orgs/{org}/tenders/{tender['id']}/members", json={"email": email}, headers=bidder)
    # Tender intelligence: base document -> requirement version 1 -> review -> approval (rules applied to inputs).
    base = _amend._upload(client, acme, bidder, tender["id"], "RfS.pdf", _amend.BASE_PDF, kind="original", issued_on="2025-01-20")
    assert base.status_code == 201, base.text
    v1 = base.json()["requirement_version"]
    scenario = client.post(
        f"/api/v1/orgs/{org}/tenders/{tender['id']}/scenarios",
        json={"name": "Solar + BESS", "workflow": "fixed_tariff", "inputs": _econ._inputs()},
        headers=bidder,
    ).json()
    rows = client.get(f"/api/v1/orgs/{org}/tenders/{tender['id']}/requirements", headers=eng).json()["version"]["requirements"]
    for row in rows:
        assert client.post(f"/api/v1/orgs/{org}/requirements/{row['id']}/review", json={"decision": "accept"}, headers=eng).status_code == 200
    approved = client.post(f"/api/v1/orgs/{org}/requirement-versions/{v1['id']}/approve", headers=bidder).json()
    assert approved["version"]["status"] == "approved" and approved["rule_set"]["certifiable"] is True
    sc = client.get(f"/api/v1/orgs/{org}/scenarios/{scenario['id']}", headers=bidder).json()
    assert sc["revision"] >= 1  # version 1 matches the engine defaults, so nothing needed applying
    # Workflow B: fixed-tariff investment evaluation (MILP dispatch).
    run_b = client.post(
        f"/api/v1/orgs/{org}/scenarios/{scenario['id']}/runs",
        json={"kind": "fixed_tariff", "solver_settings": {"tariff": 4.2, "dispatch": "milp"}},
        headers=bidder,
    ).json()
    run_b = _wait(client, org, bidder, run_b["id"], worker)
    assert run_b["status"] == "succeeded" and run_b["stale"] is False, run_b.get("error")
    # Workflow A: bid tariff optimisation.
    run_a = client.post(
        f"/api/v1/orgs/{org}/scenarios/{scenario['id']}/runs",
        json={"kind": "bid_tariff", "solver_settings": {"tariff_lo": 2.0, "tariff_hi": 12.0}},
        headers=bidder,
    ).json()
    run_a = _wait(client, org, bidder, run_a["id"], worker)
    assert run_a["status"] == "succeeded", run_a.get("error")
    assert client.get(f"/api/v1/orgs/{org}/runs/{run_a['id']}", headers=bidder).json()["result"]["tariff"] > 0
    # The amendment arrives after both runs completed.
    am = _amend._upload(
        client,
        acme,
        bidder,
        tender["id"],
        "Amendment-01.pdf",
        _amend.AMEND_PDF,
        kind="amendment",
        issued_on="2025-03-01",
        effective_on="2025-03-01",
        supersedes_document_id=base.json()["document"]["id"],
        summary_of_change="Amendment-01",
    )
    assert am.status_code == 201, am.text
    am = am.json()
    assert am["requirement_version"]["version_no"] == 2 and am["impact"] is not None
    changed = [c for c in am["changes"] if c["kind"] != "restated"]
    assert changed, am["changes"]
    for rid in (run_a["id"], run_b["id"]):
        r = client.get(f"/api/v1/orgs/{org}/runs/{rid}?include_result=false", headers=bidder).json()
        assert r["stale"] is True and "amend" in (r["stale_reason"] or "").lower()
    assert set(am["impact"]["affected_run_ids"]) >= {run_a["id"], run_b["id"]}
    tasks = client.get(f"/api/v1/orgs/{org}/tasks?tender_id={tender['id']}", headers=bidder).json()
    assert tasks and any("requirement" in t["kind"] for t in tasks), tasks
    assert any(n["kind"] for n in client.get(f"/api/v1/orgs/{org}/notifications?unread_only=true", headers=eng).json())
    # The previous baseline is preserved: version 1 still approved and readable with its rows.
    versions = client.get(f"/api/v1/orgs/{org}/tenders/{tender['id']}/requirements/versions", headers=eng).json()
    assert [(v["version_no"], v["status"]) for v in versions][:2] == [(1, "approved"), (2, "draft")]
    # A stale run cannot be awarded.
    assert (
        client.post(
            f"/api/v1/orgs/{org}/users", json={"email": "appr@acme.test", "display_name": "A", "password": "correct-horse", "role": "approver"}, headers=bidder
        ).status_code
        == 201
    )
    client.post(f"/api/v1/orgs/{org}/tenders/{tender['id']}/members", json={"email": "appr@acme.test"}, headers=bidder)
    approver = as_user("appr@acme.test")
    award_body = {"run_id": run_b["id"], "tariff_inr_per_kwh": 4.2, "capacity_mw": 50, "award_date": "2026-10-15"}
    assert client.post(f"/api/v1/orgs/{org}/tenders/{tender['id']}/awards", json=award_body, headers=approver).status_code == 422
    # Review the changes, approve version 2 (auto-applied to the scenario), rerun.
    rows2 = client.get(f"/api/v1/orgs/{org}/tenders/{tender['id']}/requirements", headers=eng).json()["version"]["requirements"]
    for row in rows2:
        if row["review_state"] == "unreviewed" and row["value"] is not None:
            assert client.post(f"/api/v1/orgs/{org}/requirements/{row['id']}/review", json={"decision": "accept"}, headers=eng).status_code == 200
    approved2 = client.post(f"/api/v1/orgs/{org}/requirement-versions/{am['requirement_version']['id']}/approve", headers=bidder).json()
    assert approved2["version"]["status"] == "approved"
    sc2 = client.get(f"/api/v1/orgs/{org}/scenarios/{scenario['id']}", headers=bidder).json()
    assert sc2["revision"] > sc["revision"]
    rerun = client.post(
        f"/api/v1/orgs/{org}/scenarios/{scenario['id']}/runs",
        json={"kind": "fixed_tariff", "solver_settings": {"tariff": 4.2, "dispatch": "milp"}, "supersedes_run_id": run_b["id"]},
        headers=bidder,
    ).json()
    rerun = _wait(client, org, bidder, rerun["id"], worker)
    assert rerun["status"] == "succeeded" and rerun["stale"] is False and rerun["supersedes_run_id"] == run_b["id"]
    assert rerun["snapshot"]["inputs"]["hash"] != run_b["snapshot"]["inputs"]["hash"]
    old = client.get(f"/api/v1/orgs/{org}/runs/{run_b['id']}", headers=bidder).json()
    assert old["status"] == "succeeded" and old["stale"] is True and old["result"]["finance"]["equity_irr"] is not None  # history kept
    # Workflow C: award from the fresh run, DPR traced to it.
    award = client.post(f"/api/v1/orgs/{org}/tenders/{tender['id']}/awards", json={**award_body, "run_id": rerun["id"]}, headers=approver)
    assert award.status_code == 201, award.text
    award = award.json()
    assert award["requirement_version_id"] == am["requirement_version"]["id"] and award["baseline"]["requirements"]["version_no"] == 2
    ws = client.post(f"/api/v1/orgs/{org}/awards/{award['id']}/dpr", headers=bidder).json()
    trace = client.get(f"/api/v1/orgs/{org}/dpr/{ws['id']}/trace", headers=bidder).json()
    assert trace["all_match"] is True and trace["run_id"] == rerun["id"] and trace["run_stale"] is False
    obligations = next(s for s in ws["version"]["sections"] if s["key"] == "tender_obligations")
    assert obligations["values"], "approved requirements flow into the DPR"
    timeline = client.get(f"/api/v1/orgs/{org}/tenders/{tender['id']}/timeline", headers=eng).json()
    actions = {e["action"] for e in timeline}
    assert {"run.launch", "award.record", "dpr.create"} & actions or len(timeline) > 10


ID_PARAMS = (
    "tender_id",
    "scenario_id",
    "run_id",
    "job_id",
    "document_id",
    "version_id",
    "requirement_version_id",
    "requirement_id",
    "task_id",
    "notification_id",
    "comment_id",
    "conversation_id",
    "action_id",
    "voice_session_id",
    "award_id",
    "workspace_id",
    "artifact_id",
    "impact_id",
    "profile_id",
    "user_id",
    "member_id",
    "rule_set_id",
)


def test_every_organisation_route_is_invisible_to_another_organisation(app, client, seed, as_user):
    acme, other = seed["acme"], seed["other"]
    bidder = as_user("bidder@acme.test")
    admin2 = as_user("admin2@other.test")
    tender = client.post(f"/api/v1/orgs/{acme.id}/tenders", json={"name": "T"}, headers=bidder).json()
    scenario = client.post(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/scenarios", json={"name": "S", "inputs": {"settings": {}}}, headers=bidder).json()
    run = client.post(f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/runs", json={"kind": "evaluate"}, headers=bidder).json()
    conv = client.post(f"/api/v1/orgs/{acme.id}/assistant/conversations", json={"tender_id": tender["id"]}, headers=bidder).json()
    ids = {
        "org_id": acme.id,
        "tender_id": tender["id"],
        "scenario_id": scenario["id"],
        "run_id": run["id"],
        "job_id": run["job"]["id"],
        "conversation_id": conv["id"],
        "kind": "result_json",
        "format": "docx",
    }
    checked = 0
    anonymous = TestClient(app)  # a fresh client: no session cookie from the logins above
    paths = app.openapi()["paths"]
    for template, ops in paths.items():
        if not template.startswith("/api/v1/orgs/{org_id}"):
            continue
        path = template
        for name in re.findall(r"{(\w+)}", template):
            path = path.replace("{" + name + "}", ids.get(name, f"{random.getrandbits(128):032x}"))
        for method in ops:
            method = method.upper()
            if method in ("HEAD", "OPTIONS"):
                continue
            kwargs = {"headers": admin2}
            if method in ("POST", "PUT", "PATCH"):
                kwargs["json"] = {}
            r = client.request(method, path, **kwargs)
            assert r.status_code == 404, f"{method} {template} answered {r.status_code} to another organisation: {r.text[:200]}"
            anon = anonymous.request(method, path, **({"json": {}} if method in ("POST", "PUT", "PATCH") else {}))
            assert anon.status_code == 401, f"{method} {template} answered {anon.status_code} without a session"
            checked += 1
    assert checked > 60, checked
    # The other organisation's administrator sees an empty world, not an error.
    assert client.get(f"/api/v1/orgs/{other.id}/tenders", headers=admin2).json() == []
    assert all(e["actor_label"] != "bidder@acme.test" for e in client.get(f"/api/v1/orgs/{other.id}/audit", headers=admin2).json())


def test_worker_death_mid_job_and_process_restart_are_recovered(client, seed, as_user, worker, settings, session_factory):
    acme = seed["acme"]
    bidder = as_user("bidder@acme.test")
    org, _, scenario = _econ._scenario(client, seed, as_user)
    run = client.post(
        f"/api/v1/orgs/{org}/scenarios/{scenario['id']}/runs",
        json={"kind": "fixed_tariff", "solver_settings": {"tariff": 4.2, "dispatch": "rules"}},
        headers=bidder,
    ).json()
    # Worker A claims the job and dies (no heartbeat, no completion).
    with session_factory() as s:
        job = jobs.claim_next(s, "worker-A", settings.job_lease_seconds)
        assert job is not None and job.id == run["job"]["id"] and job.status == "running" and job.attempts == 1
    # While the lease holds, nobody else can take it.
    assert worker.run_once() is False
    with session_factory() as s:
        s.execute(text("update job set lease_until = :t where id = :id"), {"t": datetime.now(UTC) - timedelta(seconds=1), "id": job.id})
        s.commit()
    # Worker B reclaims it after the lease expires and finishes the run.
    assert worker.run_once() is True
    with session_factory() as s:
        j = s.get(Job, job.id)
        assert j.status == "done" and j.attempts == 2 and "reclaimed" in (j.last_error or "") and j.worker_id == "test-worker"
    done = client.get(f"/api/v1/orgs/{org}/runs/{run['id']}", headers=bidder).json()
    assert done["status"] == "succeeded" and done["result"]["finance"]["equity_irr"] is not None
    # A fresh API process against the same database sees the same scenario, run and session.
    fresh = create_app(settings, mount_legacy=False)
    with TestClient(fresh) as c2:
        again = c2.get(f"/api/v1/orgs/{org}/runs/{run['id']}", headers=bidder).json()
        assert again["status"] == "succeeded" and again["snapshot"]["inputs"]["hash"] == done["snapshot"]["inputs"]["hash"]
        sc = c2.get(f"/api/v1/orgs/{org}/scenarios/{scenario['id']}", headers=bidder).json()
        assert sc["revision"] == scenario["revision"] and sc["current_input_version"]["inputs"]["supply"] == _econ._inputs()["supply"]
        assert c2.get(f"/api/v1/orgs/{acme.id}/tenders", headers=bidder).status_code == 200


def test_read_endpoints_answer_within_budget(client, seed, as_user):
    acme = seed["acme"]
    bidder = as_user("bidder@acme.test")
    tender = client.post(f"/api/v1/orgs/{acme.id}/tenders", json={"name": "T"}, headers=bidder).json()
    for i in range(5):
        client.post(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/scenarios", json={"name": f"S{i}", "inputs": _econ._inputs()}, headers=bidder)
    samples: dict[str, list[float]] = {}
    for path in (
        "/api/v1/health",
        f"/api/v1/orgs/{acme.id}/tenders",
        f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/scenarios",
        f"/api/v1/orgs/{acme.id}/history/awards?limit=20",
        f"/api/v1/orgs/{acme.id}/assistant/knowledge?tender_id={tender['id']}",
    ):
        for _ in range(15):
            t0 = time.perf_counter()
            assert client.get(path, headers=bidder).status_code == 200
            samples.setdefault(path, []).append((time.perf_counter() - t0) * 1000)
    for path, ms in samples.items():
        p95 = sorted(ms)[int(len(ms) * 0.95) - 1]
        assert p95 < 750, f"{path}: p95 {p95:.0f} ms (median {statistics.median(ms):.0f} ms)"
