"""Day 5 gate: historical comparisons preserve units and sources; concurrent edits cannot
silently overwrite work (comments are immutable, scenario saves are revision-checked);
chat, threads, mentions and decisions reach the right people."""

from __future__ import annotations

import pathlib

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from fdre_platform.services import history

DATASET = pathlib.Path("/home/user/ergplan/re-tender-results")
pytestmark_dataset = pytest.mark.skipif(
    not (DATASET / "tender-results-viewer" / "public" / "data.json").exists(), reason="RE-tender-results checkout not present"
)


@pytestmark_dataset
def test_import_is_idempotent_and_keeps_units_statuses_and_sources(session_factory, seed):
    with session_factory() as s:
        first = history.import_dataset(s, DATASET, commit_ref="test")
        s.commit()
        again = history.import_dataset(s, DATASET, commit_ref="test")
        s.commit()
    assert (
        first["records_inserted"] > 500 and again["records_inserted"] == 0 and again["records_skipped"] == first["records_inserted"] + first["records_skipped"]
    )
    assert first["rejected_hosts"] == {}
    with session_factory() as s:
        kinds = dict(s.execute(text("select result_kind, count(*) from historical_award group by 1")).all())
        units = dict(s.execute(text("select coalesce(price_unit,'<none>'), count(*) from historical_award group by 1")).all())
        fams = dict(s.execute(text("select tender_family, count(*) from historical_award group by 1")).all())
        vgf = s.execute(text("select price_unit, result_kind from historical_award where price_unit like '%VGF%' limit 1")).first()
        srcs = s.execute(text("select count(*) from historical_award where source_sha256 is null or source_url is null")).scalar_one()
    assert "INR/kWh" in units and "INR/MW VGF" in units and units["INR/kWh"] > 400
    assert vgf == ("INR/MW VGF", "vgf_support")
    assert {"awarded_tariff", "adopted_tariff", "ranking", "empanelment", "non_tariff"} <= set(kinds)
    assert fams["fdre"] >= 90 and "solar" in fams and "wind" in fams
    assert srcs == 0
    with session_factory() as s:
        fresh = history.freshness(s)
    assert fresh["records"] > 500 and fresh["dataset_as_of"] == "2026-10-07" and fresh["records_without_price"] > 0 and "not an exhaustive" in fresh["note"]


@pytestmark_dataset
def test_comparables_explain_similarity_and_refuse_incompatible_units(client, seed, as_user, session_factory):
    with session_factory() as s:
        history.import_dataset(s, DATASET, commit_ref="test")
        s.commit()
    acme = seed["acme"]
    eng = as_user("eng@acme.test")
    r = client.get(f"/api/v1/orgs/{acme.id}/history/awards?tender_family=fdre&capacity_mw=200&storage=true&limit=10", headers=eng).json()
    assert r["freshness"]["records"] > 500
    rows = r["results"]
    assert rows and all(x["comparable_tariff"] and x["price_unit"] == "INR/kWh" for x in rows)
    assert all(x["source_url"] and x["source_sha256"] and x["source_page"] for x in rows)
    assert all(any("same family" in w for w in x["why_similar"]) for x in rows)
    assert all(x["result_kind"] in ("awarded_tariff", "adopted_tariff") for x in rows)
    # VGF and other non-tariff results never appear as tariffs; with tariff_only=false they come back labelled.
    allr = client.get(f"/api/v1/orgs/{acme.id}/history/awards?tariff_only=false&limit=200", headers=eng).json()["results"]
    non = [x for x in allr if not x["comparable_tariff"]]
    assert non and all(x["why_not_comparable"] for x in non)
    assert any("VGF" in (x["price_unit"] or "") for x in non)
    # Outsiders need an organisation; the data itself is shared reference data.
    assert client.get(f"/api/v1/orgs/{acme.id}/history/awards", headers=as_user("admin2@other.test")).status_code == 404
    check = client.post(
        f"/api/v1/orgs/{acme.id}/history/dedupe-check",
        json={
            "records": [
                {
                    "source_sha256": rows[0]["source_sha256"],
                    "page": rows[0]["source_page"],
                    "bidder": rows[0]["bidder"],
                    "allocation": rows[0]["allocation"],
                    "reference": rows[0]["tender_reference"],
                }
            ]
        },
        headers=eng,
    ).json()
    assert len(check["existing"]) + len(check["new"]) == 1


def test_chat_threads_mentions_decisions_and_immutability(client, seed, as_user, session_factory):
    acme = seed["acme"]
    bidder = as_user("bidder@acme.test")
    eng = as_user("eng@acme.test")
    tender = client.post(f"/api/v1/orgs/{acme.id}/tenders", json={"name": "T"}, headers=bidder).json()
    client.post(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/members", json={"email": "eng@acme.test"}, headers=bidder)
    url = f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/comments"
    first = client.post(url, json={"body": "Kick-off: @eng@acme.test please check the CUF band", "kind": "chat"}, headers=bidder).json()
    assert first["mentions"] == [acme.users["eng"]] and first["author"] == "bidder@acme.test"
    notes = client.get(f"/api/v1/orgs/{acme.id}/notifications?unread_only=true", headers=eng).json()
    assert any(n["kind"] == "mention" and n["object_id"] == first["id"] for n in notes)
    reply = client.post(
        url, json={"body": "On it", "kind": "comment", "parent_id": first["id"], "object_type": "requirement", "object_id": "r1"}, headers=eng
    ).json()
    assert reply["parent_id"] == first["id"]
    assert any(n["kind"] == "reply" for n in client.get(f"/api/v1/orgs/{acme.id}/notifications?unread_only=true", headers=bidder).json())
    thread = client.get(url + "?object_type=requirement&object_id=r1", headers=bidder).json()
    assert [c["id"] for c in thread] == [reply["id"]]
    # Viewer can read but not write; outsider sees nothing.
    client.post(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/members", json={"email": "viewer@acme.test"}, headers=bidder)
    assert client.post(url, json={"body": "hi"}, headers=as_user("viewer@acme.test")).status_code == 403
    assert client.get(url, headers=as_user("admin2@other.test")).status_code == 404
    # A decision needs the permission and notifies members.
    assert (
        client.post(
            url, json={"body": "Approve baseline", "kind": "decision", "decision": "approved", "object_type": "scenario", "object_id": "s1"}, headers=eng
        ).status_code
        == 403
    )
    approver = client.post(
        f"/api/v1/orgs/{acme.id}/users", json={"email": "appr@acme.test", "display_name": "A", "password": "correct-horse", "role": "approver"}, headers=bidder
    )
    assert approver.status_code == 201
    client.post(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/members", json={"email": "appr@acme.test"}, headers=bidder)
    dec = client.post(
        url,
        json={"body": "Approve baseline", "kind": "decision", "decision": "approved", "object_type": "scenario", "object_id": "s1"},
        headers=as_user("appr@acme.test"),
    ).json()
    assert dec["decision"] == "approved"
    # Immutable: no edit in place, deletion is a flag that keeps the row and the audit trail.
    with session_factory() as s, pytest.raises(DBAPIError, match="immutable"):
        s.execute(text("update comment set body='changed' where id=:id"), {"id": first["id"]})
        s.commit()
    assert client.post(f"/api/v1/orgs/{acme.id}/comments/{first['id']}/delete", headers=eng).status_code == 422  # not the author
    gone = client.post(f"/api/v1/orgs/{acme.id}/comments/{first['id']}/delete", headers=bidder).json()
    assert gone["deleted"] is True and gone["body"] == ""
    events = client.get(f"/api/v1/orgs/{acme.id}/audit?object_type=comment&object_id={first['id']}", headers=bidder).json()
    assert sorted(e["action"] for e in events) == ["comment.chat", "comment.delete"]


def test_concurrent_scenario_edits_cannot_silently_overwrite(client, seed, as_user):
    acme = seed["acme"]
    bidder = as_user("bidder@acme.test")
    eng = as_user("eng@acme.test")
    tender = client.post(f"/api/v1/orgs/{acme.id}/tenders", json={"name": "T"}, headers=bidder).json()
    client.post(f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/members", json={"email": "eng@acme.test"}, headers=bidder)
    sc = client.post(
        f"/api/v1/orgs/{acme.id}/tenders/{tender['id']}/scenarios", json={"name": "S", "inputs": {"settings": {"a": 1, "b": 1}}}, headers=bidder
    ).json()
    url = f"/api/v1/orgs/{acme.id}/scenarios/{sc['id']}/inputs"
    # Both users loaded revision 1; the engineer saves b, then the bid manager saves a against the stale revision.
    assert client.put(url, json={"expected_revision": 1, "inputs": {"settings": {"a": 1, "b": 2}}}, headers=eng).status_code == 200
    stale = client.put(url, json={"expected_revision": 1, "inputs": {"settings": {"a": 2, "b": 1}}}, headers=bidder)
    assert stale.status_code == 409 and stale.json()["current_revision"] == 2
    current = client.get(f"/api/v1/orgs/{acme.id}/scenarios/{sc['id']}", headers=bidder).json()["current_input_version"]["inputs"]
    assert current == {"settings": {"a": 1, "b": 2}}  # the engineer's change survived; nothing was overwritten
    # The bid manager merges on the current revision and saves only their change.
    assert client.put(url, json={"expected_revision": 2, "inputs": {"settings": {"a": 2, "b": 2}}}, headers=bidder).status_code == 200
    versions = client.get(f"/api/v1/orgs/{acme.id}/scenarios/{sc['id']}/versions", headers=bidder).json()
    assert [(v["version_no"], v["changed_paths"]) for v in versions] == [(1, ["settings.a", "settings.b"]), (2, ["settings.b"]), (3, ["settings.a"])]
