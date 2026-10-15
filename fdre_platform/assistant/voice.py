"""RealTalk voice sessions. The server mints a short-lived session grant (with the
provider's ephemeral secret in live mode; a local token in recorded mode), the browser
streams audio directly to the provider, and every tool call and caption comes back here
through the same registry and conversation as chat. Captions and tool traces are stored;
audio is refused at the API boundary and never written anywhere."""

from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from sqlalchemy.orm import Session

from fdre_platform.assistant import knowledge, service, tools
from fdre_platform.assistant.llm import ChatModel, ToolCall
from fdre_platform.config import Settings
from fdre_platform.models import AssistantMessage, VoiceSession
from fdre_platform.services import audit
from fdre_platform.services.context import Actor
from fdre_platform.services.tenders import NotFound, ValidationFailed
from fdre_platform.storage import LocalStorage

AUDIO_KEYS = frozenset({"audio", "audio_base64", "pcm", "pcm16", "wav", "opus", "mp3", "input_audio", "delta_audio", "audio_chunk", "recording", "blob", "buffer"})
EVENT_TYPES = ("caption.user", "caption.assistant", "command", "tool_call", "interrupted", "reconnected", "ended")
POLICY = {"raw_audio_retained": False, "captions_retained": True, "tool_calls_audited": True, "api_key_in_browser": False}


def _now() -> datetime:
    return datetime.now(UTC)


def contains_audio(value: Any, depth: int = 0) -> bool:
    if depth > 6:
        return False
    if isinstance(value, dict):
        return any(str(k).lower() in AUDIO_KEYS or contains_audio(v, depth + 1) for k, v in value.items())
    if isinstance(value, list):
        return any(contains_audio(v, depth + 1) for v in value)
    if isinstance(value, str):
        return value.startswith("data:audio") or len(value) > 200_000
    return False


def dump(v: VoiceSession) -> dict[str, Any]:
    return {"id": v.id, "conversation_id": v.conversation_id, "mode": v.mode, "expires_at": v.expires_at.isoformat(), "ended_at": v.ended_at.isoformat() if v.ended_at else None, "reconnects": v.reconnects, "interruptions": v.interruptions, "caption_count": v.caption_count, "policy": v.policy, "provider_session_id": v.provider_session_id}


def get(session: Session, actor: Actor, voice_session_id: str) -> VoiceSession:
    v = session.get(VoiceSession, voice_session_id)
    if v is None or v.organization_id != actor.organization_id or v.user_id != actor.user_id:
        raise NotFound("voice session")
    return v


def _live_grant(settings: Settings, actor: Actor, instructions: str) -> dict[str, Any]:
    body = {
        "model": settings.openai_realtime_model, "modalities": ["audio", "text"], "instructions": instructions, "tools": tools.realtime_tools(actor), "tool_choice": "auto",
        "input_audio_transcription": {"model": "gpt-4o-transcribe"}, "turn_detection": {"type": "server_vad", "interrupt_response": True},
    }
    r = httpx.post(f"{settings.openai_base_url.rstrip('/')}/realtime/sessions", headers={"Authorization": f"Bearer {settings.openai_api_key}"}, json=body, timeout=20.0)
    r.raise_for_status()
    return r.json()


def create(session: Session, settings: Settings, actor: Actor, *, conversation_id: str | None, tender_id: str | None, reconnect_of: str | None = None) -> dict[str, Any]:
    if reconnect_of:
        prev = get(session, actor, reconnect_of)
        conversation_id = prev.conversation_id
        if prev.ended_at is None:
            prev.ended_at = _now()
        reconnects = prev.reconnects + 1
    else:
        reconnects = 0
    conv = service.conversation(session, actor, conversation_id) if conversation_id else service.start(session, actor, tender_id=tender_id, channel="voice", title="Voice session")
    ctx = knowledge.build(session, settings, actor, conv.tender_id)
    instructions = knowledge.SYSTEM_PROMPT + "\nSpeak briefly. " + knowledge.render(ctx, ctx.chunks[:8]) + f"\nCurrent tender id: {conv.tender_id or 'none'}. User {actor.label} (role {actor.role})."
    mode, grant, provider_session_id, fallback = "recorded", None, None, None
    if settings.assistant_provider != "recorded" and settings.openai_api_key:
        try:
            data = _live_grant(settings, actor, instructions)
            mode = "live"
            provider_session_id = data.get("id")
            grant = {"client_secret": data["client_secret"]["value"], "expires_at": data["client_secret"].get("expires_at"), "model": settings.openai_realtime_model, "base_url": settings.openai_base_url}
        except Exception as exc:  # noqa: BLE001 - the browser falls back to recorded/text mode and says why
            fallback = f"live voice unavailable: {type(exc).__name__}"
    expires = _now() + timedelta(minutes=settings.voice_session_ttl_minutes)
    v = VoiceSession(organization_id=actor.organization_id, created_by=actor.user_id, conversation_id=conv.id, user_id=actor.user_id or "", mode=mode, provider_session_id=provider_session_id, expires_at=expires, reconnects=reconnects, policy=POLICY)
    session.add(v)
    session.flush()
    audit.record(session, actor, "voice.session.start", "voice_session", v.id, after={"mode": mode, "conversation_id": conv.id, "reconnect_of": reconnect_of, "fallback": fallback}, tender_id=conv.tender_id)
    out = {**dump(v), "knowledge_version": ctx.version, "tools": [s.name for s in tools.specs_for(actor)], "text_fallback": True, "fallback_reason": fallback, "local_token": secrets.token_urlsafe(16) if mode == "recorded" else None}
    if grant:
        out["grant"] = grant    # the ephemeral client secret; never the API key, never stored
    return out


def _check_open(v: VoiceSession) -> None:
    if v.ended_at is not None:
        raise ValidationFailed("voice session ended; start a new one")
    if v.expires_at < _now():
        raise ValidationFailed("voice session expired; reconnect")


def record_event(session: Session, settings: Settings, storage: LocalStorage, model: ChatModel, actor: Actor, voice_session_id: str, event: dict[str, Any]) -> dict[str, Any]:
    if contains_audio(event):
        raise ValidationFailed("raw audio is not accepted or retained; send captions and tool calls only")
    v = get(session, actor, voice_session_id)
    kind = event.get("type")
    if kind not in EVENT_TYPES:
        raise ValidationFailed(f"unknown event type {kind!r}")
    conv = service.conversation(session, actor, v.conversation_id)
    if kind == "ended":
        v.ended_at = v.ended_at or _now()
        session.flush()
        audit.record(session, actor, "voice.session.end", "voice_session", v.id, after={"captions": v.caption_count, "interruptions": v.interruptions, "reconnects": v.reconnects}, tender_id=conv.tender_id)
        return {"ok": True, "session": dump(v)}
    _check_open(v)
    if kind in ("caption.user", "caption.assistant"):
        text = knowledge.sanitize(event.get("text") or "")[:4000]
        if not text.strip():
            raise ValidationFailed("empty caption")
        session.add(AssistantMessage(organization_id=actor.organization_id, created_by=actor.user_id, conversation_id=conv.id, role="user" if kind == "caption.user" else "assistant", channel="voice", content=text, provider="live" if v.mode == "live" else "recorded", voice_session_id=v.id))
        v.caption_count += 1
        session.flush()
        return {"ok": True, "captions": v.caption_count}
    if kind == "interrupted":
        v.interruptions += 1
        session.flush()
        return {"ok": True, "interruptions": v.interruptions}
    if kind == "reconnected":
        v.reconnects += 1
        session.flush()
        return {"ok": True, "reconnects": v.reconnects}
    if kind == "command":
        # Recorded mode: the browser's speech recognition produced a final transcript; it is
        # handled exactly like a typed chat message, through the same registry.
        result = service.send(session, settings, storage, model, actor, conversation_id=conv.id, text=event.get("text") or "", channel="voice", voice_session_id=v.id, scenario_id=event.get("scenario_id"))
        v.caption_count += 1
        session.flush()
        return {"ok": True, **result}
    # kind == "tool_call": the live model asked for a tool over the data channel.
    name = str(event.get("name") or "")
    args = event.get("arguments") or {}
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except json.JSONDecodeError:
            args = {"_unparseable": args}
    call_id = str(event.get("call_id") or f"voice_{secrets.token_hex(6)}")
    amsg = AssistantMessage(organization_id=actor.organization_id, created_by=actor.user_id, conversation_id=conv.id, role="assistant", channel="voice", content="", tool_calls=[{"id": call_id, "name": name, "arguments": args}], provider="live", model=settings.openai_realtime_model, voice_session_id=v.id)
    session.add(amsg)
    session.flush()
    actions: list[Any] = []
    output = service.handle_tool_call(session, settings, storage, actor, conv, ToolCall(id=call_id, name=name, arguments=args), channel="voice", voice_session_id=v.id, message_id=amsg.id, actions=actions)
    session.add(AssistantMessage(organization_id=actor.organization_id, created_by=actor.user_id, conversation_id=conv.id, role="tool", channel="voice", tool_name=name, tool_call_id=call_id, content=json.dumps(output, default=str), voice_session_id=v.id))
    session.flush()
    return {"ok": True, "call_id": call_id, "output": output, "actions": [service.dump_action(a) for a in actions]}


def end(session: Session, actor: Actor, voice_session_id: str) -> VoiceSession:
    v = get(session, actor, voice_session_id)
    if v.ended_at is None:
        v.ended_at = _now()
        session.flush()
    return v
