"""Model adapters. `OpenAIChatModel` calls the Chat Completions API with the server-side
key. `RecordedChatModel` is the deterministic fake used when no key is configured (this
build container has neither a key nor a route to the provider): it answers from a
fixture of patterns and is labelled `recorded` on every message. `ScriptedChatModel`
replays given turns and exists for adversarial tests that simulate a compromised model."""

from __future__ import annotations

import json
import pathlib
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

from fdre_platform.config import Settings


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class ModelTurn:
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    provider: str = "recorded"
    model: str = "recorded-v1"
    usage: dict[str, Any] = field(default_factory=dict)
    latency_ms: int = 0


class ChatModel(Protocol):
    provider: str

    def respond(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], *, context: dict[str, Any]) -> ModelTurn: ...


def _call_id() -> str:
    return "call_" + uuid.uuid4().hex[:12]


class OpenAIChatModel:
    provider = "openai"

    def __init__(self, api_key: str, model: str, base_url: str = "https://api.openai.com/v1", timeout: float = 60.0) -> None:
        self._key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def respond(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], *, context: dict[str, Any]) -> ModelTurn:
        t0 = time.perf_counter()
        body: dict[str, Any] = {"model": self.model, "messages": messages}
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        r = httpx.post(f"{self.base_url}/chat/completions", headers={"Authorization": f"Bearer {self._key}"}, json=body, timeout=self.timeout)
        r.raise_for_status()
        data = r.json()
        msg = data["choices"][0]["message"]
        calls = []
        for tc in msg.get("tool_calls") or []:
            try:
                args = json.loads(tc["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {"_unparseable": tc["function"].get("arguments")}
            calls.append(ToolCall(id=tc.get("id") or _call_id(), name=tc["function"]["name"], arguments=args))
        return ModelTurn(content=msg.get("content") or "", tool_calls=calls, provider="openai", model=data.get("model", self.model), usage=data.get("usage") or {}, latency_ms=int((time.perf_counter() - t0) * 1000))


class RecordedChatModel:
    """Pattern rules from a fixture: each rule has a regex over the user's message, the tool
    to call with argument templates ($1.. from the regex, $tender_id / $scenario_id from the
    conversation context) and an answer template. After tool results the model summarises
    them verbatim. It never reads the <data> blocks, so it cannot be steered by them."""

    provider = "recorded"

    def __init__(self, fixture: pathlib.Path) -> None:
        self.fixture = pathlib.Path(fixture)
        self.rules: list[dict[str, Any]] = json.loads(self.fixture.read_text())["rules"]
        self.model = "recorded-v1"

    @staticmethod
    def _fill(value: Any, groups: dict[str, str], context: dict[str, Any]) -> Any:
        if isinstance(value, str):
            def sub(m: re.Match[str]) -> str:
                key = m.group(1)
                if key.isdigit():
                    return groups.get(key, "")
                return str(context.get(key) or "")

            out = re.sub(r"\$(\w+)", sub, value).strip()
            if out == "":
                return None
            if len(out) >= 20:   # identifiers stay strings even when they are all digits
                return out
            try:
                if re.fullmatch(r"-?\d+", out):
                    return int(out)
                if re.fullmatch(r"-?\d+\.\d+", out):
                    return float(out)
            except ValueError:
                pass
            return out
        if isinstance(value, dict):
            return {k: RecordedChatModel._fill(v, groups, context) for k, v in value.items()}
        return value

    def respond(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], *, context: dict[str, Any]) -> ModelTurn:
        last = messages[-1]
        allowed = {t["function"]["name"] for t in tools}
        if last.get("role") == "tool":
            results = []
            for m in reversed(messages):
                if m.get("role") != "tool":
                    break
                results.append(m)
            lines = []
            for m in reversed(results):
                try:
                    payload = json.loads(m.get("content") or "null")
                except json.JSONDecodeError:
                    payload = m.get("content")
                lines.append(self._describe(m.get("name") or "tool", payload))
            return ModelTurn(content="\n".join(lines) + "\n(recorded assistant: answers are built from tool results only)")
        text = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                text = m.get("content") or ""
                break
        for rule in self.rules:
            m = re.search(rule["pattern"], text, re.I)
            if not m:
                continue
            groups = {str(i + 1): (g or "") for i, g in enumerate(m.groups())}
            calls = []
            for call in rule.get("tool_calls", []):
                if call["tool"] not in allowed:
                    return ModelTurn(content=f"I cannot do that here: the tool {call['tool']} is not available to you.")
                args = {k: v for k, v in self._fill(call.get("arguments", {}), groups, context).items() if v is not None}
                calls.append(ToolCall(id=_call_id(), name=call["tool"], arguments=args))
            return ModelTurn(content=self._fill(rule.get("answer", ""), groups, context) or "", tool_calls=calls)
        return ModelTurn(content="I did not understand that (recorded assistant). Try: 'summarise the tender', 'list scenarios', 'create a scenario called X', 'launch a fixed tariff run at 4.2 on scenario X', 'comparable awards for 200 MW fdre'.")

    @staticmethod
    def _describe(name: str, payload: Any) -> str:
        if isinstance(payload, dict) and payload.get("error"):
            return f"{name}: refused ({payload['error']}: {payload.get('message')})"
        if isinstance(payload, dict) and payload.get("status") == "proposed":
            return f"{name}: proposed action {payload['action_id']} awaits your confirmation: {payload['preview']}"
        if isinstance(payload, list):
            head = payload[:8]
            return f"{name}: {len(payload)} item(s)\n" + "\n".join("  - " + ", ".join(f"{k}: {v}" for k, v in (row.items() if isinstance(row, dict) else [("value", row)]) if v not in (None, "", [])) for row in head)
        if isinstance(payload, dict):
            return f"{name}: " + "; ".join(f"{k}: {json.dumps(v, default=str)[:200]}" for k, v in payload.items() if v not in (None, "", []))
        return f"{name}: {payload}"


class ScriptedChatModel:
    provider = "scripted"
    model = "scripted"

    def __init__(self, turns: list[ModelTurn]) -> None:
        self.turns = list(turns)
        self.seen: list[list[dict[str, Any]]] = []

    def respond(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], *, context: dict[str, Any]) -> ModelTurn:
        self.seen.append(messages)
        if not self.turns:
            return ModelTurn(content="(scripted model: no more turns)", provider="scripted", model="scripted")
        t = self.turns.pop(0)
        t.provider, t.model = "scripted", "scripted"
        return t


def build_model(settings: Settings) -> ChatModel:
    if settings.assistant_provider == "openai" or (settings.assistant_provider == "auto" and settings.openai_api_key):
        return OpenAIChatModel(settings.openai_api_key, settings.openai_chat_model, settings.openai_base_url)
    return RecordedChatModel(settings.assistant_fixture)
