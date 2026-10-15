"""The embedded assistant (chat) and RealTalk voice sessions. Routes only: the registry,
knowledge layer and conversation service decide what may happen."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, Request
from pydantic import BaseModel

from fdre_platform.api.deps import ActorDep, SessionDep, SettingsDep, StorageDep
from fdre_platform.assistant import knowledge, service, tools, voice

router = APIRouter(prefix="/orgs/{org_id}/assistant", tags=["assistant"])


def _model(request: Request):
    return request.app.state.chat_model


class ConversationIn(BaseModel):
    tender_id: str | None = None
    channel: str = "chat"
    title: str = ""


class MessageIn(BaseModel):
    text: str
    scenario_id: str | None = None


class VoiceSessionIn(BaseModel):
    conversation_id: str | None = None
    tender_id: str | None = None
    reconnect_of: str | None = None


class VoiceEventIn(BaseModel):
    model_config = {"extra": "allow"}
    type: str


class RejectIn(BaseModel):
    reason: str = ""


@router.get("/tools")
def list_tools(actor: ActorDep) -> list[dict[str, Any]]:
    return [
        {"name": s.name, "description": s.description, "permission": s.permission, "mutating": s.mutating, "parameters": s.parameters}
        for s in tools.specs_for(actor)
    ]


@router.get("/knowledge")
def knowledge_context(session: SessionDep, settings: SettingsDep, actor: ActorDep, tender_id: str | None = None) -> dict[str, Any]:
    return knowledge.build(session, settings, actor, tender_id).as_dict()


@router.post("/conversations", status_code=201)
def start_conversation(body: ConversationIn, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    c = service.start(session, actor, tender_id=body.tender_id, channel=body.channel, title=body.title)
    session.commit()
    return {"id": c.id, "tender_id": c.tender_id, "channel": c.channel, "title": c.title}


@router.get("/conversations")
def list_conversations(session: SessionDep, actor: ActorDep, tender_id: str | None = None) -> list[dict[str, Any]]:
    return [
        {
            "id": c.id,
            "tender_id": c.tender_id,
            "channel": c.channel,
            "title": c.title,
            "knowledge_version": c.knowledge_version,
            "last_message_at": c.last_message_at.isoformat() if c.last_message_at else None,
            "created_at": c.created_at.isoformat(),
        }
        for c in service.list_conversations(session, actor, tender_id)
    ]


@router.get("/conversations/{conversation_id}/messages")
def list_messages(conversation_id: str, session: SessionDep, actor: ActorDep) -> list[dict[str, Any]]:
    return [service.dump_message(m) for m in service.messages(session, actor, conversation_id)]


@router.post("/conversations/{conversation_id}/messages", status_code=201)
def send_message(
    conversation_id: str, body: MessageIn, request: Request, session: SessionDep, settings: SettingsDep, storage: StorageDep, actor: ActorDep
) -> dict[str, Any]:
    out = service.send(
        session, settings, storage, _model(request), actor, conversation_id=conversation_id, text=body.text, channel="chat", scenario_id=body.scenario_id
    )
    session.commit()
    return out


@router.get("/conversations/{conversation_id}/actions")
def list_actions(conversation_id: str, session: SessionDep, actor: ActorDep, status: str | None = None) -> list[dict[str, Any]]:
    return [service.dump_action(a) for a in service.pending_actions(session, actor, conversation_id) if status is None or a.status == status]


@router.post("/actions/{action_id}/confirm")
def confirm_action(
    action_id: str, session: SessionDep, settings: SettingsDep, storage: StorageDep, actor: ActorDep, idempotency_key: str | None = Header(default=None)
) -> dict[str, Any]:
    a = service.confirm(session, settings, storage, actor, action_id, idempotency_key=idempotency_key)
    session.commit()
    return service.dump_action(a)


@router.post("/actions/{action_id}/reject")
def reject_action(action_id: str, session: SessionDep, actor: ActorDep, body: RejectIn | None = None) -> dict[str, Any]:
    a = service.reject(session, actor, action_id)
    session.commit()
    return service.dump_action(a)


@router.post("/voice/sessions", status_code=201)
def start_voice(body: VoiceSessionIn, session: SessionDep, settings: SettingsDep, actor: ActorDep) -> dict[str, Any]:
    out = voice.create(session, settings, actor, conversation_id=body.conversation_id, tender_id=body.tender_id, reconnect_of=body.reconnect_of)
    session.commit()
    return out


@router.get("/voice/sessions/{voice_session_id}")
def get_voice(voice_session_id: str, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    return voice.dump(voice.get(session, actor, voice_session_id))


@router.post("/voice/sessions/{voice_session_id}/events")
def voice_event(
    voice_session_id: str, body: VoiceEventIn, request: Request, session: SessionDep, settings: SettingsDep, storage: StorageDep, actor: ActorDep
) -> dict[str, Any]:
    out = voice.record_event(session, settings, storage, _model(request), actor, voice_session_id, body.model_dump())
    session.commit()
    return out


@router.post("/voice/sessions/{voice_session_id}/end")
def end_voice(voice_session_id: str, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    v = voice.end(session, actor, voice_session_id)
    session.commit()
    return voice.dump(v)
