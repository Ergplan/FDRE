"""Conversations: store every turn, build the knowledge context, run the model, execute
read tools, turn mutating tool calls into proposals and execute a proposal only on the
proposing user's confirmation, once per idempotency key. Chat and voice share this code."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from fdre_platform.assistant import knowledge, tools
from fdre_platform.assistant.llm import ChatModel, ToolCall
from fdre_platform.assistant.tools import ToolContext, ToolError
from fdre_platform.config import Settings
from fdre_platform.models import AssistantAction, AssistantConversation, AssistantMessage
from fdre_platform.services import audit, scenarios, tenders
from fdre_platform.services.context import Actor, PermissionDenied
from fdre_platform.services.tenders import Conflict, NotFound, ValidationFailed
from fdre_platform.storage import LocalStorage

MAX_TOOL_ROUNDS = 4


def _now() -> datetime:
    return datetime.now(UTC)


def conversation(session: Session, actor: Actor, conversation_id: str) -> AssistantConversation:
    c = session.get(AssistantConversation, conversation_id)
    if c is None or c.organization_id != actor.organization_id or c.user_id != actor.user_id:
        raise NotFound("conversation")
    return c


def start(session: Session, actor: Actor, *, tender_id: str | None, channel: str = "chat", title: str = "") -> AssistantConversation:
    if channel not in ("chat", "voice"):
        raise ValidationFailed("channel must be chat or voice")
    if tender_id:
        tenders.get(session, actor, tender_id)  # membership and organisation scope
    if actor.user_id is None:
        raise PermissionDenied("assistant.use")
    c = AssistantConversation(
        organization_id=actor.organization_id, created_by=actor.user_id, tender_id=tender_id, user_id=actor.user_id, channel=channel, title=title[:300]
    )
    session.add(c)
    session.flush()
    audit.record(
        session, actor, "assistant.conversation.start", "assistant_conversation", c.id, after={"tender_id": tender_id, "channel": channel}, tender_id=tender_id
    )
    return c


def list_conversations(session: Session, actor: Actor, tender_id: str | None = None) -> list[AssistantConversation]:
    stmt = select(AssistantConversation).where(AssistantConversation.organization_id == actor.organization_id, AssistantConversation.user_id == actor.user_id)
    if tender_id:
        stmt = stmt.where(AssistantConversation.tender_id == tender_id)
    return list(session.scalars(stmt.order_by(AssistantConversation.created_at.desc()).limit(50)))


def messages(session: Session, actor: Actor, conversation_id: str) -> list[AssistantMessage]:
    c = conversation(session, actor, conversation_id)
    return list(
        session.scalars(select(AssistantMessage).where(AssistantMessage.conversation_id == c.id).order_by(AssistantMessage.seq))
    )


def dump_message(m: AssistantMessage) -> dict[str, Any]:
    return {
        "id": m.id,
        "role": m.role,
        "channel": m.channel,
        "content": m.content,
        "tool_calls": m.tool_calls,
        "tool_name": m.tool_name,
        "tool_call_id": m.tool_call_id,
        "knowledge_version": m.knowledge_version,
        "provider": m.provider,
        "model": m.model,
        "latency_ms": m.latency_ms,
        "voice_session_id": m.voice_session_id,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def dump_action(a: AssistantAction) -> dict[str, Any]:
    return {
        "id": a.id,
        "conversation_id": a.conversation_id,
        "tool": a.tool,
        "arguments": a.arguments,
        "preview": a.preview,
        "status": a.status,
        "result": a.result,
        "error": a.error,
        "channel": a.channel,
        "voice_session_id": a.voice_session_id,
        "expires_at": a.expires_at.isoformat(),
        "decided_at": a.decided_at.isoformat() if a.decided_at else None,
        "audit_event_ids": a.audit_event_ids,
        "created_at": a.created_at.isoformat() if a.created_at else None,
    }


def _openai_history(msgs: list[AssistantMessage]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in msgs:
        if m.role == "user":
            out.append({"role": "user", "content": m.content})
        elif m.role == "assistant":
            d: dict[str, Any] = {"role": "assistant", "content": m.content}
            if m.tool_calls:
                d["tool_calls"] = [
                    {"id": tc["id"], "type": "function", "function": {"name": tc["name"], "arguments": json.dumps(tc["arguments"])}} for tc in m.tool_calls
                ]
            out.append(d)
        elif m.role == "tool":
            out.append({"role": "tool", "tool_call_id": m.tool_call_id, "name": m.tool_name, "content": m.content})
    return out


def send(
    session: Session,
    settings: Settings,
    storage: LocalStorage,
    model: ChatModel,
    actor: Actor,
    *,
    conversation_id: str,
    text: str,
    channel: str = "chat",
    voice_session_id: str | None = None,
    scenario_id: str | None = None,
) -> dict[str, Any]:
    conv = conversation(session, actor, conversation_id)
    text = (text or "").strip()
    if not text:
        raise ValidationFailed("empty message")
    if len(text) > 8000:
        raise ValidationFailed("message too long")
    ctx = knowledge.build(session, settings, actor, conv.tender_id)
    conv.knowledge_version = ctx.version
    conv.last_message_at = _now()
    if not conv.title:
        conv.title = text[:120]
    history = messages(session, actor, conv.id)
    user_msg = AssistantMessage(
        organization_id=actor.organization_id,
        created_by=actor.user_id,
        conversation_id=conv.id,
        role="user",
        channel=channel,
        content=text,
        knowledge_version=ctx.version,
        voice_session_id=voice_session_id,
    )
    session.add(user_msg)
    session.flush()
    audit.record(
        session,
        actor,
        "assistant.message",
        "assistant_conversation",
        conv.id,
        after={"message_id": user_msg.id, "role": "user", "channel": channel, "chars": len(text), "knowledge_version": ctx.version},
        tender_id=conv.tender_id,
    )
    context_vars: dict[str, Any] = {"tender_id": conv.tender_id, "scenario_id": scenario_id}
    if scenario_id:
        try:
            context_vars["revision"] = scenarios.get(session, actor, scenario_id).revision
        except NotFound:
            context_vars["scenario_id"] = None
    chunks = knowledge.search(ctx, text)
    system = (
        knowledge.SYSTEM_PROMPT
        + "\n"
        + knowledge.render(ctx, chunks)
        + f"\nCurrent tender id: {conv.tender_id or 'none selected'}. Current scenario id: {scenario_id or 'none selected'}. User: {actor.label} (role {actor.role}). Channel: {channel}."
    )
    convo: list[dict[str, Any]] = [{"role": "system", "content": system}, *_openai_history(history), {"role": "user", "content": text}]
    tool_specs = tools.openai_tools(actor)
    new_msgs: list[AssistantMessage] = []
    actions: list[AssistantAction] = []
    for _round in range(MAX_TOOL_ROUNDS):
        turn = model.respond(convo, tool_specs, context=context_vars)
        amsg = AssistantMessage(
            organization_id=actor.organization_id,
            created_by=actor.user_id,
            conversation_id=conv.id,
            role="assistant",
            channel=channel,
            content=turn.content or "",
            tool_calls=[{"id": tc.id, "name": tc.name, "arguments": tc.arguments} for tc in turn.tool_calls],
            knowledge_version=ctx.version,
            provider=turn.provider,
            model=turn.model,
            usage=turn.usage,
            latency_ms=turn.latency_ms,
            voice_session_id=voice_session_id,
        )
        session.add(amsg)
        session.flush()
        new_msgs.append(amsg)
        entry: dict[str, Any] = {"role": "assistant", "content": turn.content or ""}
        if turn.tool_calls:
            entry["tool_calls"] = [
                {"id": tc.id, "type": "function", "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)}} for tc in turn.tool_calls
            ]
        convo.append(entry)
        if not turn.tool_calls:
            break
        for tc in turn.tool_calls:
            result = handle_tool_call(
                session, settings, storage, actor, conv, tc, channel=channel, voice_session_id=voice_session_id, message_id=amsg.id, actions=actions
            )
            tmsg = AssistantMessage(
                organization_id=actor.organization_id,
                created_by=actor.user_id,
                conversation_id=conv.id,
                role="tool",
                channel=channel,
                tool_name=tc.name,
                tool_call_id=tc.id,
                content=json.dumps(result, default=str),
                knowledge_version=ctx.version,
                voice_session_id=voice_session_id,
            )
            session.add(tmsg)
            session.flush()
            new_msgs.append(tmsg)
            convo.append({"role": "tool", "tool_call_id": tc.id, "name": tc.name, "content": tmsg.content})
    else:
        stop = AssistantMessage(
            organization_id=actor.organization_id,
            created_by=actor.user_id,
            conversation_id=conv.id,
            role="assistant",
            channel=channel,
            content=f"Stopped after {MAX_TOOL_ROUNDS} tool rounds.",
            knowledge_version=ctx.version,
            provider="platform",
            model="limit",
            voice_session_id=voice_session_id,
        )
        session.add(stop)
        session.flush()
        new_msgs.append(stop)
    return {
        "conversation_id": conv.id,
        "knowledge_version": ctx.version,
        "provider": model.provider,
        "messages": [dump_message(m) for m in [user_msg, *new_msgs]],
        "actions": [dump_action(a) for a in actions],
    }


def handle_tool_call(
    session: Session,
    settings: Settings,
    storage: LocalStorage,
    actor: Actor,
    conv: AssistantConversation,
    tc: ToolCall,
    *,
    channel: str,
    voice_session_id: str | None,
    message_id: str | None,
    actions: list[AssistantAction],
) -> Any:
    """Read tools run now; mutating tools become proposals; anything else is refused and
    audited. Tool arguments come from the model only, never from retrieved text."""
    ctx = ToolContext(session=session, settings=settings, storage=storage, actor=actor, tender_id=conv.tender_id)
    try:
        spec = tools.resolve(tc.name)
    except ToolError as exc:
        audit.record(
            session,
            actor,
            "assistant.tool_refused",
            "assistant_conversation",
            conv.id,
            after={"tool": tc.name, "code": exc.code, "arguments": tc.arguments, "channel": channel},
            tender_id=conv.tender_id,
        )
        return {"error": exc.code, "message": str(exc)}
    if spec.mutating:
        try:
            _, clean, preview = tools.preview_mutation(ctx, tc.name, tc.arguments)
        except ToolError as exc:
            audit.record(
                session,
                actor,
                "assistant.tool_refused",
                "assistant_conversation",
                conv.id,
                after={"tool": tc.name, "code": exc.code, "arguments": tc.arguments, "channel": channel},
                tender_id=conv.tender_id,
            )
            return {"error": exc.code, "message": str(exc)}
        action = AssistantAction(
            organization_id=actor.organization_id,
            created_by=actor.user_id,
            conversation_id=conv.id,
            message_id=message_id,
            user_id=actor.user_id or "",
            channel=channel,
            voice_session_id=voice_session_id,
            tool=tc.name,
            arguments=clean,
            preview=preview,
            status="proposed",
            expires_at=_now() + timedelta(minutes=settings.assistant_action_ttl_minutes),
        )
        session.add(action)
        session.flush()
        audit.record(
            session,
            actor,
            "assistant.action.proposed",
            "assistant_action",
            action.id,
            after={"tool": tc.name, "arguments": clean, "preview": preview, "channel": channel, "voice_session_id": voice_session_id, "conversation_id": conv.id},
            tender_id=conv.tender_id,
        )
        actions.append(action)
        return {
            "status": "proposed",
            "action_id": action.id,
            "tool": tc.name,
            "preview": preview,
            "note": "nothing has changed; the user must confirm this action",
        }
    try:
        result = tools.invoke_read(ctx, tc.name, tc.arguments)
    except ToolError as exc:
        audit.record(
            session,
            actor,
            "assistant.tool_refused",
            "assistant_conversation",
            conv.id,
            after={"tool": tc.name, "code": exc.code, "arguments": tc.arguments, "channel": channel},
            tender_id=conv.tender_id,
        )
        return {"error": exc.code, "message": str(exc)}
    audit.record(
        session,
        actor,
        "assistant.tool_call",
        "assistant_conversation",
        conv.id,
        after={"tool": tc.name, "arguments": tc.arguments, "channel": channel},
        tender_id=conv.tender_id,
    )
    return result


def action(session: Session, actor: Actor, action_id: str) -> AssistantAction:
    a = session.get(AssistantAction, action_id)
    if a is None or a.organization_id != actor.organization_id:
        raise NotFound("action")
    return a


def pending_actions(session: Session, actor: Actor, conversation_id: str) -> list[AssistantAction]:
    c = conversation(session, actor, conversation_id)
    return list(session.scalars(select(AssistantAction).where(AssistantAction.conversation_id == c.id).order_by(AssistantAction.created_at)))


def confirm(session: Session, settings: Settings, storage: LocalStorage, actor: Actor, action_id: str, *, idempotency_key: str | None) -> AssistantAction:
    a = action(session, actor, action_id)
    if a.user_id != actor.user_id:
        raise PermissionDenied("assistant.action.confirm (only the user who asked can confirm)")
    conv = conversation(session, actor, a.conversation_id)
    if a.status == "executed":
        if idempotency_key and a.idempotency_key == idempotency_key:
            return a  # replay of the same confirmation: same result, nothing executed twice
        raise Conflict(f"action {a.id} was already executed", current_revision=None, conflicts=[{"status": a.status}])
    if a.status != "proposed":
        raise ValidationFailed(f"action is {a.status}")
    if a.expires_at < _now():
        a.status = "expired"
        a.decided_at = _now()
        session.flush()
        audit.record(session, actor, "assistant.action.expired", "assistant_action", a.id, tender_id=conv.tender_id)
        raise ValidationFailed("the proposal expired; ask again")
    if idempotency_key:
        other = session.scalar(select(AssistantAction).where(AssistantAction.idempotency_key == idempotency_key, AssistantAction.id != a.id))
        if other is not None:
            raise Conflict("idempotency key already used for another action", current_revision=None, conflicts=[{"action_id": other.id}])
    ctx = ToolContext(session=session, settings=settings, storage=storage, actor=actor, tender_id=conv.tender_id)
    try:
        result = tools.execute_mutation(ctx, a.tool, a.arguments)
    except ToolError as exc:
        a.status = "failed"
        a.error = f"{exc.code}: {exc}"
        a.decided_at = _now()
        session.flush()
        audit.record(session, actor, "assistant.action.failed", "assistant_action", a.id, after={"tool": a.tool, "error": a.error}, tender_id=conv.tender_id)
        if exc.code == "forbidden":
            raise PermissionDenied(tools.resolve(a.tool).permission) from exc
        if exc.code == "not_found":
            raise NotFound(str(exc)) from exc
        raise ValidationFailed(str(exc)) from exc
    final_result = result if isinstance(result, dict) else {"value": result}
    ev = audit.record(
        session,
        actor,
        "assistant.action.executed",
        "assistant_action",
        a.id,
        after={
            "tool": a.tool,
            "arguments": a.arguments,
            "result": final_result,
            "channel": a.channel,
            "voice_session_id": a.voice_session_id,
            "conversation_id": conv.id,
        },
        tender_id=conv.tender_id,
    )
    # one UPDATE: the row is final once status leaves "proposed" (database trigger)
    a.result = final_result
    a.status = "executed"
    a.idempotency_key = idempotency_key
    a.decided_at = _now()
    a.audit_event_ids = [ev.id]
    session.add(
        AssistantMessage(
            organization_id=actor.organization_id,
            created_by=actor.user_id,
            conversation_id=conv.id,
            role="tool",
            channel=a.channel,
            tool_name=a.tool,
            tool_call_id=a.id,
            content=json.dumps({"status": "executed", "action_id": a.id, "result": a.result}, default=str),
            voice_session_id=a.voice_session_id,
        )
    )
    session.flush()
    return a


def reject(session: Session, actor: Actor, action_id: str) -> AssistantAction:
    a = action(session, actor, action_id)
    if a.user_id != actor.user_id:
        raise PermissionDenied("assistant.action.reject (only the user who asked can reject)")
    if a.status != "proposed":
        raise ValidationFailed(f"action is {a.status}")
    a.status = "rejected"
    a.decided_at = _now()
    session.flush()
    audit.record(
        session,
        actor,
        "assistant.action.rejected",
        "assistant_action",
        a.id,
        after={"tool": a.tool},
        tender_id=conversation(session, actor, a.conversation_id).tender_id,
    )
    return a
