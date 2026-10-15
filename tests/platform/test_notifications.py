from __future__ import annotations

from fdre_platform.services import notifications


def test_notifications_dedupe_and_unread_state(client, seed, as_user, session_factory):
    acme = seed["acme"]
    uid = acme.users["eng"]
    with session_factory() as s:
        assert notifications.notify(s, organization_id=acme.id, user_ids=[uid, uid], kind="amendment", title="Amendment 1", dedupe_key="amend:1:" + uid) == 1
        assert notifications.notify(s, organization_id=acme.id, user_ids=[uid], kind="amendment", title="Amendment 1", dedupe_key="amend:1:" + uid) == 0
        s.commit()
    eng = as_user("eng@acme.test")
    unread = client.get(f"/api/v1/orgs/{acme.id}/notifications?unread_only=true", headers=eng).json()
    assert len(unread) == 1 and unread[0]["read_at"] is None
    read = client.post(f"/api/v1/orgs/{acme.id}/notifications/{unread[0]['id']}/read", headers=eng).json()
    assert read["read_at"]
    assert client.get(f"/api/v1/orgs/{acme.id}/notifications?unread_only=true", headers=eng).json() == []
    # Another user of the same organisation does not see it; another organisation cannot reach it.
    assert client.get(f"/api/v1/orgs/{acme.id}/notifications", headers=as_user("bidder@acme.test")).json() == []
    assert client.post(f"/api/v1/orgs/{acme.id}/notifications/{unread[0]['id']}/read", headers=as_user("admin2@other.test")).status_code == 404
