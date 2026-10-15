"""Day 1 gate: a saved scenario survives a restart; concurrent edits cannot silently
overwrite; a run is an immutable snapshot executed by the durable worker."""

from __future__ import annotations

import json

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from fdre_platform.api.app import create_app
from fdre_platform.services.scenarios import changed_paths, inputs_hash


def _tender_and_scenario(client, seed, headers, inputs=None):
    acme = seed["acme"]
    tender = client.post(f"/api/v1/orgs/{acme.id}/tenders", json={"name": "T1"}, headers=headers).json()
    scenario = client.post(
        f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/scenarios",
        json={"name": "S1", "inputs": inputs or {"settings": {"solarAcMw": 300, "windMw": 31.5}}},
        headers=headers,
    ).json()
    return tender, scenario


def test_changed_paths_and_hash_are_deterministic():
    a = {"settings": {"solarAcMw": 300, "bess": {"mw": 185}}, "list": [1, 2]}
    b = {"settings": {"solarAcMw": 310, "bess": {"mw": 185}}, "list": [1, 3]}
    assert changed_paths(a, b) == ["list", "settings.solarAcMw"]
    assert inputs_hash(a) == inputs_hash(json.loads(json.dumps(a)))
    assert inputs_hash(a) != inputs_hash(b)


def test_saved_scenario_survives_an_application_restart(client, seed, as_user, settings):
    acme = seed["acme"]
    headers = as_user("bidder@acme.test")
    tender, scenario = _tender_and_scenario(client, seed, headers)
    # A fresh application instance with its own engine and pool: the record is in the database.
    from fastapi.testclient import TestClient

    with TestClient(create_app(settings, mount_legacy=False)) as fresh:
        again = fresh.get(f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}", headers=headers).json()
    assert again["current_input_version"]["inputs"] == {"settings": {"solarAcMw": 300, "windMw": 31.5}}
    assert again["revision"] == 1
    versions = client.get(f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/versions", headers=headers).json()
    assert [v["version_no"] for v in versions] == [1]


def test_stale_revision_is_a_visible_conflict_not_an_overwrite(client, seed, as_user):
    acme = seed["acme"]
    bidder = as_user("bidder@acme.test")
    admin = as_user("admin@acme.test")
    tender, scenario = _tender_and_scenario(client, seed, bidder)
    url = f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/inputs"
    # Both load revision 1. Admin saves first.
    ok = client.put(url, json={"expected_revision": 1, "inputs": {"settings": {"solarAcMw": 350, "windMw": 31.5}}}, headers=admin)
    assert ok.status_code == 200 and ok.json()["revision"] == 2
    # Bid manager saves against revision 1: refused, told the current revision and what they changed.
    stale = client.put(url, json={"expected_revision": 1, "inputs": {"settings": {"solarAcMw": 300, "windMw": 40}}}, headers=bidder)
    assert stale.status_code == 409
    body = stale.json()
    assert body["current_revision"] == 2 and body["conflicts"] == ["settings.solarAcMw", "settings.windMw"]
    # Nothing was overwritten.
    current = client.get(f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}", headers=bidder).json()
    assert current["current_input_version"]["inputs"]["settings"] == {"solarAcMw": 350, "windMw": 31.5}
    # Retrying with the current revision succeeds and keeps every version.
    retry = client.put(url, json={"expected_revision": 2, "inputs": {"settings": {"solarAcMw": 350, "windMw": 40}}}, headers=bidder)
    assert retry.status_code == 200 and retry.json()["revision"] == 3
    versions = client.get(f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/versions", headers=bidder).json()
    assert [v["version_no"] for v in versions] == [1, 2, 3]
    assert versions[2]["changed_paths"] == ["settings.windMw"]


def test_input_versions_are_immutable_in_the_database(client, seed, as_user, session_factory):
    bidder = as_user("bidder@acme.test")
    _, scenario = _tender_and_scenario(client, seed, bidder)
    vid = scenario["current_input_version"]["id"]
    with session_factory() as s:
        with pytest.raises(DBAPIError, match="append-only"):
            s.execute(text("update scenario_input_version set inputs='{}'::jsonb where id=:id"), {"id": vid})
            s.commit()


def test_locked_scenario_refuses_input_changes(client, seed, as_user):
    acme = seed["acme"]
    bidder = as_user("bidder@acme.test")
    _, scenario = _tender_and_scenario(client, seed, bidder)
    locked = client.patch(f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}", json={"expected_revision": 1, "status": "locked"}, headers=bidder)
    assert locked.status_code == 200 and locked.json()["status"] == "locked"
    r = client.put(f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/inputs", json={"expected_revision": 2, "inputs": {"settings": {}}}, headers=bidder)
    assert r.status_code == 422 and "locked" in r.json()["message"]


def engine_inputs():
    import fdre_enterprise_engine as E

    project = E.default_fdre2_project()
    # The bundled portfolio with synthetic wind misses the monthly peak test; price the
    # shortfall instead of refusing, so the evaluate run produces a tariff.
    project.finance.hard_compliance_required = False
    return {"project": E.project_to_dict(project), "run_options": {"years_mode": "fast", "use_wind_profile": False}, "settings": {"solarAcMw": 300}}


def test_run_is_an_immutable_snapshot_executed_by_the_worker(client, seed, as_user, worker, session_factory):
    acme = seed["acme"]
    bidder = as_user("bidder@acme.test")
    tender, scenario = _tender_and_scenario(client, seed, bidder, inputs=engine_inputs())
    launch = client.post(
        f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/runs", json={"kind": "evaluate"}, headers={**bidder, "Idempotency-Key": "launch-1"}
    )
    assert launch.status_code == 202, launch.text
    run = launch.json()
    assert run["status"] == "queued" and run["job"]["status"] == "queued"
    snap = run["snapshot"]
    assert snap["tenant"]["organization_id"] == acme.id
    assert snap["tender"]["id"] == tender["id"] and snap["scenario"]["id"] == scenario["id"]
    assert snap["creator"]["user_id"] == acme.users["bidder"] and snap["submitted_at"]
    assert snap["inputs"]["hash"] == scenario["current_input_version"]["inputs_hash"]
    assert snap["rules_version"] and snap["finance_version"] and snap["solver_version"] and snap["kind"] == "evaluate"
    # Same idempotency key: the same run, not a second one.
    again = client.post(f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/runs", json={"kind": "evaluate"}, headers={**bidder, "Idempotency-Key": "launch-1"})
    assert again.status_code == 202 and again.json()["id"] == run["id"]
    # The worker picks it up.
    assert worker.run_once() is True
    assert worker.run_once() is False
    done = client.get(f"/api/v1/orgs/{acme.id}/runs/{run['id']}", headers=bidder).json()
    assert done["status"] == "succeeded", done["error"]
    assert done["job"]["status"] == "done" and done["metrics"]["runtime_seconds"] > 0
    assert done["metrics"]["status_reason"] == "ok" and done["metrics"]["tariff_rs_per_kwh"] > 0
    assert done["result"]["tariff"] == done["metrics"]["tariff_rs_per_kwh"]
    assert done["metrics"]["artifact_hashes"]["result.json"]
    artifact = client.get(f"/api/v1/orgs/{acme.id}/runs/{run['id']}/artifacts/result_json", headers=bidder)
    assert artifact.status_code == 200 and artifact.headers["X-Content-SHA256"] == done["metrics"]["artifact_hashes"]["result.json"]
    # Completed: the database refuses any change to what it computed.
    with session_factory() as s:
        with pytest.raises(DBAPIError, match="immutable"):
            s.execute(text("update run set result='{}'::jsonb where id=:id"), {"id": run["id"]})
            s.commit()
        s.rollback()
        with pytest.raises(DBAPIError, match="never deleted"):
            s.execute(text("delete from run where id=:id"), {"id": run["id"]})
            s.commit()
    # Changing the inputs afterwards does not alter the run; it marks it stale.
    saved = client.put(
        f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/inputs",
        json={"expected_revision": 1, "inputs": {**engine_inputs(), "settings": {"solarAcMw": 310}}},
        headers=bidder,
    )
    assert saved.status_code == 200
    stale = client.get(f"/api/v1/orgs/{acme.id}/runs/{run['id']}", headers=bidder).json()
    assert stale["stale"] is True and "settings.solarAcMw" in stale["stale_reason"]
    assert stale["result"] == done["result"]
    # The worker's own write is audited too.
    events = client.get(f"/api/v1/orgs/{acme.id}/audit?object_type=run&object_id={run['id']}", headers=bidder).json()
    assert sorted(e["action"] for e in events) == ["run.finish", "run.launch"]
    assert next(e for e in events if e["action"] == "run.finish")["actor_label"] == "worker"


def test_worker_retries_then_fails_a_broken_run(client, seed, as_user, worker, session_factory):
    acme = seed["acme"]
    bidder = as_user("bidder@acme.test")
    _, scenario = _tender_and_scenario(client, seed, bidder, inputs={"project": {"not": "an engine project"}, "settings": {}})
    run = client.post(f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/runs", json={"kind": "evaluate"}, headers=bidder).json()
    assert worker.run_once() is True
    first = client.get(f"/api/v1/orgs/{acme.id}/runs/{run['id']}", headers=bidder).json()
    assert first["status"] == "failed" and "engine schema" in first["error"]
    assert first["job"]["status"] == "queued" and first["job"]["attempts"] == 1  # retry scheduled with backoff
    with session_factory() as s:
        s.execute(text("update job set run_after = now() where id=:id"), {"id": first["job"]["id"]})
        s.commit()
    assert worker.run_once() is True
    with session_factory() as s:
        s.execute(text("update job set run_after = now() where id=:id"), {"id": first["job"]["id"]})
        s.commit()
    assert worker.run_once() is True
    final = client.get(f"/api/v1/orgs/{acme.id}/runs/{run['id']}", headers=bidder).json()
    assert final["job"]["status"] == "failed" and final["job"]["attempts"] == 3 and final["job"]["last_error"]


def test_queued_run_can_be_cancelled(client, seed, as_user, worker):
    acme = seed["acme"]
    bidder = as_user("bidder@acme.test")
    _, scenario = _tender_and_scenario(client, seed, bidder, inputs=engine_inputs())
    run = client.post(f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/runs", json={"kind": "evaluate"}, headers=bidder).json()
    cancelled = client.post(f"/api/v1/orgs/{acme.id}/runs/{run['id']}/cancel", headers=bidder).json()
    assert cancelled["status"] == "cancelled" and cancelled["job"]["status"] == "cancelled"
    assert worker.run_once() is False
    assert client.post(f"/api/v1/orgs/{acme.id}/runs/{run['id']}/cancel", headers=bidder).status_code == 422


def test_viewer_cannot_launch_runs(client, seed, as_user):
    acme = seed["acme"]
    admin = as_user("admin@acme.test")
    viewer = as_user("viewer@acme.test")
    _, scenario = _tender_and_scenario(client, seed, admin)
    client.post(f"/api/v1/orgs/{acme.id}/tenders/{scenario['tender_id']}/members", json={"email": "viewer@acme.test"}, headers=admin)
    assert client.post(f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/runs", json={"kind": "evaluate"}, headers=viewer).status_code == 403
