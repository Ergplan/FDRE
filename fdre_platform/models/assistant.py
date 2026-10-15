"""Assistant conversations (chat and voice), their messages, proposed actions and voice
sessions. Messages and executed actions are immutable (database triggers). Voice
sessions keep captions and tool traces only: no audio is ever stored."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Identity, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, IdMixin, OrgMixin

ACTION_STATUSES = ("proposed", "executed", "rejected", "expired", "failed")


class AssistantConversation(IdMixin, OrgMixin, Base):
    __tablename__ = "assistant_conversation"
    tender_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("tender.id"), nullable=True, index=True)
    user_id: Mapped[str] = mapped_column(String(32), ForeignKey("app_user.id"), nullable=False, index=True)
    channel: Mapped[str] = mapped_column(String(16), nullable=False, default="chat")  # chat | voice
    title: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    knowledge_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AssistantMessage(IdMixin, OrgMixin, Base):
    """One turn. `tool_calls` holds what the model asked for; `tool_name` and `content`
    hold a tool result when role = tool. Immutable."""

    __tablename__ = "assistant_message"
    seq: Mapped[int] = mapped_column(Integer, Identity(), nullable=False, unique=True)   # strict order of turns
    conversation_id: Mapped[str] = mapped_column(String(32), ForeignKey("assistant_conversation.id"), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(16), nullable=False)  # user | assistant | tool
    channel: Mapped[str] = mapped_column(String(16), nullable=False, default="chat")
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    tool_calls: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    tool_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tool_call_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    knowledge_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    provider: Mapped[str | None] = mapped_column(String(32), nullable=True)  # openai | recorded | scripted
    model: Mapped[str | None] = mapped_column(String(64), nullable=True)
    usage: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    voice_session_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)


class AssistantAction(IdMixin, OrgMixin, Base):
    """A mutation the assistant proposed. Nothing changes until the same user confirms it;
    the confirmation carries an idempotency key so a retried confirm executes once."""

    __tablename__ = "assistant_action"
    conversation_id: Mapped[str] = mapped_column(String(32), ForeignKey("assistant_conversation.id"), nullable=False, index=True)
    message_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    user_id: Mapped[str] = mapped_column(String(32), ForeignKey("app_user.id"), nullable=False, index=True)
    channel: Mapped[str] = mapped_column(String(16), nullable=False, default="chat")
    voice_session_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    tool: Mapped[str] = mapped_column(String(64), nullable=False)
    arguments: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    preview: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="proposed", index=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(200), nullable=True, unique=True)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    audit_event_ids: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)


class VoiceSession(IdMixin, OrgMixin, Base):
    """A RealTalk session grant. The provider's ephemeral secret is handed to the browser
    once and never stored; the API key never leaves the server."""

    __tablename__ = "voice_session"
    conversation_id: Mapped[str] = mapped_column(String(32), ForeignKey("assistant_conversation.id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(32), ForeignKey("app_user.id"), nullable=False, index=True)
    mode: Mapped[str] = mapped_column(String(16), nullable=False)  # live | recorded
    provider_session_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reconnects: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    interruptions: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    caption_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    policy: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
