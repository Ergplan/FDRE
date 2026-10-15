"""Day 1 gate: two users work in the same authorised tender; another tenant cannot reach
its data; every mutation carries an attributable audit record."""

from __future__ import annotations

from fdre_platform.permissions import ROLE_PERMISSIONS, ROLES, has_permission


def test_permission_matrix_is_explicit():
    assert set(ROLE_PERMISSIONS) == set(ROLES)
    assert has_permission("administrator", "org.manage")
    assert not has_permission("viewer", "scenario.edit")
    assert has_permission("approver", "bid.approve") and not has_permission("bid_manager", "bid.approve")
    assert has_permission("finance_reviewer", "finance.edit") and not has_permission("engineer", "finance.edit")


def test_login_rejects_bad_password_and_unknown_user(client, seed):
    r = client.post("/api/v1/auth/login", json={"email": "admin@acme.test", "password": "wrong-password"})
    assert r.status_code == 400
    r2 = client.post("/api/v1/auth/login", json={"email": "nobody@acme.test", "password": "wrong-password"})
    assert r2.status_code == 400 and r2.json()["message"] == r.json()["message"]
    assert client.get("/api/v1/auth/me").status_code == 401


def test_me_lists_memberships_and_permissions(client, seed, as_user):
    me = client.get("/api/v1/auth/me", headers=as_user("eng@acme.test")).json()
    assert [o["slug"] for o in me["organizations"]] == ["acme"]
    assert me["organizations"][0]["role"] == "engineer"
    assert "run.launch" in me["organizations"][0]["permissions"]


def test_two_users_share_an_authorised_tender(client, seed, as_user):
    acme = seed["acme"]
    bidder = as_user("bidder@acme.test")
    eng = as_user("eng@acme.test")
    tender = client.post(f"/api/v1/orgs/{acme.id}/tenders", json={"name": "NHPC FDRE Tranche-II", "procurer": "NHPC"}, headers=bidder).json()
    # The engineer is not yet a member: the tender does not exist for them.
    assert client.get(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}", headers=eng).status_code == 404
    assert client.post(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/members", json={"email": "eng@acme.test"}, headers=bidder).status_code == 201
    assert client.get(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}", headers=eng).status_code == 200
    # Engineer creates a scenario; bid manager sees it and saves the next version.
    scenario = client.post(
        f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/scenarios", json={"name": "Base case", "inputs": {"settings": {"solarAcMw": 300}}}, headers=eng
    ).json()
    assert scenario["revision"] == 1 and scenario["current_input_version"]["version_no"] == 1
    listed = client.get(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/scenarios", headers=bidder).json()
    assert [s["id"] for s in listed] == [scenario["id"]]
    saved = client.put(
        f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/inputs", json={"expected_revision": 1, "inputs": {"settings": {"solarAcMw": 320}}}, headers=bidder
    ).json()
    assert saved["revision"] == 2 and saved["current_input_version"]["changed_paths"] == ["settings.solarAcMw"]
    # The engineer, reloading, sees the bid manager's version with its author.
    reloaded = client.get(f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}", headers=eng).json()
    assert reloaded["current_input_version"]["inputs"]["settings"]["solarAcMw"] == 320
    assert reloaded["updated_by"] == acme.users["bidder"]
    # Administrators see every tender without a membership row.
    admin = as_user("admin@acme.test")
    assert client.get(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}", headers=admin).status_code == 200


def test_another_tenant_cannot_reach_the_data(client, seed, as_user):
    acme, other = seed["acme"], seed["other"]
    bidder = as_user("bidder@acme.test")
    outsider = as_user("admin2@other.test")
    tender = client.post(f"/api/v1/orgs/{acme.id}/tenders", json={"name": "T1"}, headers=bidder).json()
    scenario = client.post(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/scenarios", json={"name": "S1", "inputs": {"a": 1}}, headers=bidder).json()
    # Through acme's URLs: not a member of acme -> 404, no existence leak.
    assert client.get(f"/api/v1/orgs/{acme.id}/tenders", headers=outsider).status_code == 404
    assert client.get(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}", headers=outsider).status_code == 404
    assert client.get(f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}", headers=outsider).status_code == 404
    # Through their own organisation's URLs with acme's ids: still 404.
    assert client.get(f"/api/v1/orgs/{other.id}/tenders/{tender['id']}", headers=outsider).status_code == 404
    assert client.get(f"/api/v1/orgs/{other.id}/scenarios/{scenario['id']}", headers=outsider).status_code == 404
    assert (
        client.put(
            f"/api/v1/orgs/{other.id}/scenarios/{scenario['id']}/inputs", json={"expected_revision": 1, "inputs": {"a": 2}}, headers=outsider
        ).status_code
        == 404
    )
    assert client.post(f"/api/v1/orgs/{other.id}/scenarios/{scenario['id']}/runs", json={"kind": "evaluate"}, headers=outsider).status_code == 404
    assert client.get(f"/api/v1/orgs/{other.id}/tenders", headers=outsider).json() == []
    # And acme's audit trail is invisible to them.
    assert client.get(f"/api/v1/orgs/{acme.id}/audit", headers=outsider).status_code == 404
    theirs = client.get(f"/api/v1/orgs/{other.id}/audit", headers=outsider).json()
    assert all(e["object_id"] not in (tender["id"], scenario["id"]) for e in theirs)


def test_viewer_cannot_mutate(client, seed, as_user):
    acme = seed["acme"]
    admin = as_user("admin@acme.test")
    viewer = as_user("viewer@acme.test")
    tender = client.post(f"/api/v1/orgs/{acme.id}/tenders", json={"name": "T1"}, headers=admin).json()
    client.post(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/members", json={"email": "viewer@acme.test"}, headers=admin)
    assert client.get(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}", headers=viewer).status_code == 200
    assert client.post(f"/api/v1/orgs/{acme.id}/tenders", json={"name": "T2"}, headers=viewer).status_code == 403
    assert client.post(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/scenarios", json={"name": "S"}, headers=viewer).status_code == 403
    assert (
        client.post(
            f"/api/v1/orgs/{acme.id}/users", json={"email": "x@acme.test", "display_name": "x", "password": "correct-horse", "role": "viewer"}, headers=viewer
        ).status_code
        == 403
    )


def test_finance_inputs_need_finance_permission(client, seed, as_user):
    acme = seed["acme"]
    admin = as_user("admin@acme.test")
    eng = as_user("eng@acme.test")
    fin = as_user("fin@acme.test")
    tender = client.post(f"/api/v1/orgs/{acme.id}/tenders", json={"name": "T1"}, headers=admin).json()
    for email in ("eng@acme.test", "fin@acme.test"):
        client.post(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/members", json={"email": email}, headers=admin)
    # The engineer cannot even create the scenario with finance inputs in it.
    assert (
        client.post(
            f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/scenarios",
            json={"name": "S", "inputs": {"settings": {"solarAcMw": 300}, "finance": {"targetEquityIrr": 14}}},
            headers=eng,
        ).status_code
        == 403
    )
    scenario = client.post(
        f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/scenarios",
        json={"name": "S", "inputs": {"settings": {"solarAcMw": 300}, "finance": {"targetEquityIrr": 14}}},
        headers=admin,
    ).json()
    # Engineer may change technical inputs but not finance.
    r = client.put(
        f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/inputs",
        json={"expected_revision": 1, "inputs": {"settings": {"solarAcMw": 300}, "finance": {"targetEquityIrr": 15}}},
        headers=eng,
    )
    assert r.status_code == 403
    r = client.put(
        f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/inputs",
        json={"expected_revision": 1, "inputs": {"settings": {"solarAcMw": 300}, "finance": {"targetEquityIrr": 15}}},
        headers=fin,
    )
    assert r.status_code == 200
    # Finance reviewer may not change technical inputs.
    r = client.put(
        f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/inputs",
        json={"expected_revision": 2, "inputs": {"settings": {"solarAcMw": 350}, "finance": {"targetEquityIrr": 15}}},
        headers=fin,
    )
    assert r.status_code == 403


def test_every_mutation_has_an_attributable_audit_record(client, seed, as_user):
    acme = seed["acme"]
    bidder = as_user("bidder@acme.test")
    tender = client.post(f"/api/v1/orgs/{acme.id}/tenders", json={"name": "T1"}, headers={**bidder, "X-Request-Id": "req-tender"}).json()
    client.patch(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}", json={"expected_revision": 1, "changes": {"procurer": "SECI"}}, headers=bidder)
    scenario = client.post(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/scenarios", json={"name": "S", "inputs": {"x": 1}}, headers=bidder).json()
    client.put(f"/api/v1/orgs/{acme.id}/scenarios/{scenario['id']}/inputs", json={"expected_revision": 1, "inputs": {"x": 2}, "note": "bump"}, headers=bidder)
    client.post(
        f"/api/v1/orgs/{acme.id}/users", json={"email": "new@acme.test", "display_name": "New", "password": "correct-horse", "role": "viewer"}, headers=bidder
    )
    events = [e for e in client.get(f"/api/v1/orgs/{acme.id}/audit", headers=bidder).json() if e["actor_label"] not in ("seed", "bootstrap")]
    actions = sorted(e["action"] for e in events)
    for expected in ("tender.create", "tender.update", "scenario.create", "scenario.inputs.save", "membership.create"):
        assert expected in actions, actions
    for e in events:
        assert e["actor_user_id"] == acme.users["bidder"] and e["actor_label"] == "bidder@acme.test"
    created = next(e for e in events if e["action"] == "tender.create")
    assert created["request_id"] == "req-tender" and created["object_version"] == 1
    updated = next(e for e in events if e["action"] == "tender.update")
    assert updated["before"]["procurer"] == "" and updated["after"]["procurer"] == "SECI" and updated["object_version"] == 2
    saved = next(e for e in events if e["action"] == "scenario.inputs.save")
    assert saved["after"]["changed_paths"] == ["x"] and saved["after"]["note"] == "bump"
    member = next(e for e in events if e["action"] == "membership.create")
    assert "password" not in str(member["after"])


def test_audit_log_is_append_only_in_the_database(session_factory, seed):
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError

    with session_factory() as s:
        row = s.execute(text("select id from audit_event limit 1")).first()
        assert row is not None
        for stmt in ("update audit_event set action='x' where id=:id", "delete from audit_event where id=:id"):
            try:
                s.execute(text(stmt), {"id": row[0]})
                s.commit()
                raise AssertionError("mutation was allowed")
            except DBAPIError as exc:
                assert "append-only" in str(exc)
                s.rollback()
