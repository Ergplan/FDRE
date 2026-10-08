"""The only module that calls a model SDK: versioned prompts in, typed answers out.

Ported from Ergplan/tender_engine core/llm/client.py and core/llm/registry.py
(commit bd4959c), without the call log, batches and prompt cache. Prompts are files
<root>/<name>/<version>.md with a header between two '---' lines; a prompt whose header
says `extends: <name>/<version>` is the parent's text followed by its own.

The provider is Anthropic (ANTHROPIC_API_KEY) or OpenAI (OPENAI_API_KEY): the one
TENDER_INTEL_PROVIDER names, else the one whose key is set (Anthropic first). Both get the
same prompts, the same PDF pages and the same response schema; the answer is a draft
either way, checked against the pages by tender_intel.extract.

The model is never named in code: it is read from TENDER_INTEL_MODEL, or, when that is
unset, picked once per process from the models the API key can use (Anthropic: the first
listed id that contains "opus", else the first listed; OpenAI: the highest plain gpt-N id).
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ValidationError

PACKAGE_ROOT = Path(__file__).resolve().parent
PROMPT_ROOTS: tuple[Path, ...] = (
    PACKAGE_ROOT / "prompts",
    PACKAGE_ROOT / "packs" / "core" / "prompts",
    PACKAGE_ROOT / "packs" / "power" / "prompts",
)
DEFAULT_MAX_TOKENS = 16000
# OpenAI counts reasoning tokens in the output limit, so its calls get more room.
OPENAI_MIN_OUTPUT_TOKENS = 32000
DEFAULT_TIMEOUT_SECONDS = 300.0
MAX_RETRIES = 3
TOOL_NAME = "record_answer"
PROVIDERS = ("anthropic", "openai")
KEY_ENV = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY"}
_OPENAI_PLAIN = re.compile(r"^gpt-(\d+(?:\.\d+)?)$")
_NAME = re.compile(r"^[a-z0-9_]+(/[a-z0-9_]+)*$")
_VERSION = re.compile(r"^v[0-9]+$")
_model_lock = threading.Lock()
_process_model: str | None = None
_default_client: "LLMClient | None" = None


class UnregisteredPromptError(LookupError):
    pass


class LLMError(RuntimeError):
    """The call did not produce a validated answer."""


@dataclass(frozen=True)
class Prompt:
    name: str
    version: str
    header: dict[str, str]
    text: str
    sha256: str


def _split(raw: str, path: Path) -> tuple[dict[str, str], str]:
    """Split the header block (between two '---' lines) from the prompt body."""
    parts = raw.split("---\n", 2)
    if len(parts) != 3 or parts[0].strip():
        raise UnregisteredPromptError(f"{path} has no header block")
    header: dict[str, str] = {}
    for line in parts[1].splitlines():
        key, sep, value = line.partition(":")
        if sep:
            header[key.strip()] = value.strip()
    required = {"purpose", "inputs", "output_schema", "known_failure_modes"}
    missing = required - header.keys()
    if missing:
        raise UnregisteredPromptError(f"{path} header is missing {sorted(missing)}")
    body = parts[2].strip()
    if not body:
        raise UnregisteredPromptError(f"{path} has an empty body")
    return header, body


def load_prompt(
    name: str,
    version: str,
    roots: tuple[Path, ...] = PROMPT_ROOTS,
    _seen: tuple[tuple[str, str], ...] = (),
) -> Prompt:
    """Load prompt <name>/<version>.md from the first root that has it, or refuse. The
    system text of a prompt that extends another is the parent's text, then its own."""
    if not _NAME.match(name) or not _VERSION.match(version):
        raise UnregisteredPromptError(f"invalid prompt reference {name!r} {version!r}")
    if (name, version) in _seen:
        raise UnregisteredPromptError(f"prompt {name}/{version} extends itself")
    for root in roots:
        path = root / name / f"{version}.md"
        if path.is_file():
            raw = path.read_text(encoding="utf-8")
            header, text = _split(raw, path)
            digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
            if "extends" in header:
                parent_name, _, parent_version = header["extends"].rpartition("/")
                parent = load_prompt(parent_name, parent_version, roots, (*_seen, (name, version)))
                text = f"{parent.text}\n\n{text}"
                digest = hashlib.sha256(f"{parent.sha256}{digest}".encode()).hexdigest()
            return Prompt(name=name, version=version, header=header, text=text, sha256=digest)
    raise UnregisteredPromptError(f"prompt {name}/{version} is not registered")


def provider() -> str:
    """TENDER_INTEL_PROVIDER when it names a provider, else the first provider whose key is
    set; "" when no key is set."""
    chosen = (os.environ.get("TENDER_INTEL_PROVIDER") or "").strip().lower()
    if chosen in PROVIDERS:
        return chosen
    return next((name for name in PROVIDERS if (os.environ.get(KEY_ENV[name]) or "").strip()), "")


def api_key() -> str:
    name = provider()
    return (os.environ.get(KEY_ENV[name]) or "").strip() if name else ""


def llm_available() -> bool:
    """A key is configured and its provider's package can be imported."""
    if not api_key():
        return False
    try:
        importlib.import_module(provider())
    except Exception:  # noqa: BLE001
        return False
    return True


def max_output_tokens(requested: int) -> int:
    """The OpenAI output limit: TENDER_INTEL_MAX_OUTPUT_TOKENS, else at least
    OPENAI_MIN_OUTPUT_TOKENS."""
    try:
        return int(os.environ.get("TENDER_INTEL_MAX_OUTPUT_TOKENS") or max(requested, OPENAI_MIN_OUTPUT_TOKENS))
    except ValueError:
        return max(requested, OPENAI_MIN_OUTPUT_TOKENS)


def timeout_seconds() -> float:
    try:
        return float(os.environ.get("TENDER_INTEL_TIMEOUT_SECONDS") or DEFAULT_TIMEOUT_SECONDS)
    except ValueError:
        return DEFAULT_TIMEOUT_SECONDS


def _pick_model(sdk: Any, provider_name: str = "anthropic") -> str:
    """Anthropic: the first listed model whose id contains "opus", else the first listed.
    OpenAI: the plain gpt-N id with the highest N (no mini, nano or dated variants)."""
    ids = [getattr(model, "id", None) for model in sdk.models.list()]
    ids = [model_id for model_id in ids if model_id]
    if not ids:
        raise LLMError("the API key lists no models; set TENDER_INTEL_MODEL")
    if provider_name == "openai":
        plain = [
            (tuple(int(part) for part in match.group(1).split(".")), model_id)
            for model_id in ids
            if (match := _OPENAI_PLAIN.match(model_id))
        ]
        if not plain:
            raise LLMError("the API key lists no gpt-N model; set TENDER_INTEL_MODEL")
        return max(plain)[1]
    return next((model_id for model_id in ids if "opus" in model_id.lower()), ids[0])


def _usage(message: Any) -> dict[str, int]:
    usage = getattr(message, "usage", None)
    if usage is None:
        return {"input_tokens": 0, "output_tokens": 0}
    tokens_in = int(getattr(usage, "input_tokens", 0) or 0)
    tokens_in += int(getattr(usage, "cache_creation_input_tokens", 0) or 0)
    tokens_in += int(getattr(usage, "cache_read_input_tokens", 0) or 0)
    return {"input_tokens": tokens_in, "output_tokens": int(getattr(usage, "output_tokens", 0) or 0)}


def _openai_usage(response: Any) -> dict[str, int]:
    usage = getattr(response, "usage", None)
    if usage is None:
        return {"input_tokens": 0, "output_tokens": 0}
    return {
        "input_tokens": int(getattr(usage, "input_tokens", 0) or 0),
        "output_tokens": int(getattr(usage, "output_tokens", 0) or 0),
    }


def _openai_input(content_blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The user turn in the Responses API form: a PDF document block becomes an input_file
    (the same base64 pages), a text block an input_text."""
    parts: list[dict[str, Any]] = []
    for block in content_blocks:
        kind = block.get("type")
        if kind == "text":
            parts.append({"type": "input_text", "text": block["text"]})
        elif kind == "document" and block.get("source", {}).get("type") == "base64":
            source = block["source"]
            title = str(block.get("title") or "document")
            filename = title if title.lower().endswith(".pdf") else f"{title}.pdf"
            parts.append(
                {"type": "input_file", "filename": filename, "file_data": f"data:{source['media_type']};base64,{source['data']}"}
            )
        else:
            raise LLMError(f"content block {kind!r} has no OpenAI form")
    return [{"role": "user", "content": parts}]


def _check_openai(response: Any) -> None:
    if getattr(response, "status", None) == "incomplete":
        reason = getattr(getattr(response, "incomplete_details", None), "reason", None)
        if reason == "max_output_tokens":
            raise LLMError("the answer hit the output token limit (TENDER_INTEL_MAX_OUTPUT_TOKENS)")
        raise LLMError(f"the answer is incomplete ({reason})")
    for item in getattr(response, "output", None) or []:
        for part in getattr(item, "content", None) or []:
            if getattr(part, "type", None) == "refusal":
                raise LLMError(f"the model declined the request ({getattr(part, 'refusal', '')})")


def _check_stop(message: Any) -> None:
    stop = getattr(message, "stop_reason", None)
    if stop == "refusal":
        details = getattr(message, "stop_details", None)
        reason = f"{getattr(details, 'category', '')}: {getattr(details, 'explanation', '')}" if details else "no details"
        raise LLMError(f"the model declined the request ({reason})")
    if stop == "max_tokens":
        raise LLMError("the answer hit the output token limit")


class LLMClient:
    """One SDK client and one model for the process (or for an injected SDK object)."""

    def __init__(self, sdk: Any | None = None, provider_name: str | None = None) -> None:
        self._injected = sdk is not None
        self.provider = provider_name or provider() or "anthropic"
        if self.provider not in PROVIDERS:
            raise LLMError(f"unknown provider {self.provider!r}; one of {list(PROVIDERS)}")
        if sdk is None:
            key = (os.environ.get(KEY_ENV[self.provider]) or "").strip()
            if not key:
                raise LLMError(f"{KEY_ENV[self.provider]} is not set")
            if self.provider == "openai":
                import openai

                sdk = openai.OpenAI(api_key=key, max_retries=MAX_RETRIES, timeout=timeout_seconds())
            else:
                import anthropic

                sdk = anthropic.Anthropic(api_key=key, max_retries=MAX_RETRIES, timeout=timeout_seconds())
        self._sdk = sdk
        self._model: str | None = None
        self._lock = threading.Lock()

    @property
    def model(self) -> str:
        """TENDER_INTEL_MODEL, else the model picked from the API's list (once per
        process for the real client, once per client for an injected SDK)."""
        global _process_model
        configured = (os.environ.get("TENDER_INTEL_MODEL") or "").strip()
        if configured:
            return configured
        if self._injected:
            with self._lock:
                if self._model is None:
                    self._model = _pick_model(self._sdk, self.provider)
                return self._model
        with _model_lock:
            if _process_model is None:
                _process_model = _pick_model(self._sdk, self.provider)
            return _process_model

    def call(
        self,
        prompt_name: str,
        version: str,
        content_blocks: list[dict[str, Any]],
        response_model: type[BaseModel],
        max_tokens: int = DEFAULT_MAX_TOKENS,
    ) -> tuple[BaseModel, dict[str, int]]:
        """One model call: the registered prompt as system text, the content blocks as the
        user turn, the answer parsed into response_model. Returns (parsed, usage)."""
        prompt = load_prompt(prompt_name, version)
        if self.provider == "openai":
            return self._call_openai(prompt, content_blocks, response_model, max_tokens)
        params: dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens,
            "system": prompt.text,
            "messages": [{"role": "user", "content": content_blocks}],
        }
        try:
            parse = self._sdk.messages.parse
            message = parse(**params, output_format=response_model)
        except (AttributeError, TypeError):
            return self._call_with_tool(params, response_model)
        _check_stop(message)
        parsed = getattr(message, "parsed_output", None)
        if parsed is None:
            raise LLMError("the answer did not match the schema")
        if not isinstance(parsed, response_model):
            parsed = response_model.model_validate(parsed)
        return parsed, _usage(message)

    def _call_openai(
        self, prompt: Prompt, content_blocks: list[dict[str, Any]], response_model: type[BaseModel], max_tokens: int
    ) -> tuple[BaseModel, dict[str, int]]:
        """The same call through the OpenAI Responses API: the prompt as instructions, the
        pages as an input file, the answer as strict structured output (response_model)."""
        params: dict[str, Any] = {
            "model": self.model,
            "instructions": prompt.text,
            "input": _openai_input(content_blocks),
            "max_output_tokens": max_output_tokens(max_tokens),
        }
        effort = (os.environ.get("TENDER_INTEL_REASONING_EFFORT") or "").strip()
        if effort:
            params["reasoning"] = {"effort": effort}
        try:
            response = self._sdk.responses.parse(**params, text_format=response_model)
        except ValidationError as exc:
            raise LLMError(f"the answer did not match the schema: {exc.errors()[:3]}") from exc
        _check_openai(response)
        parsed = getattr(response, "output_parsed", None)
        if parsed is None:
            raise LLMError("the answer did not match the schema")
        if not isinstance(parsed, response_model):
            parsed = response_model.model_validate(parsed)
        return parsed, _openai_usage(response)

    def _call_with_tool(
        self, params: dict[str, Any], response_model: type[BaseModel]
    ) -> tuple[BaseModel, dict[str, int]]:
        """For an SDK without messages.parse(output_format=...): the answer as the input
        of a tool whose schema is the response model. Forced tool use first; a model that
        does not take a forced tool choice is asked again with the choice left to it."""
        tool = {
            "name": TOOL_NAME,
            "description": "Record the answer in the required structure.",
            "input_schema": response_model.model_json_schema(),
        }
        try:
            message = self._sdk.messages.create(
                **params, tools=[tool], tool_choice={"type": "tool", "name": TOOL_NAME}
            )
        except Exception as exc:  # noqa: BLE001 - a 400 for the forced choice
            if getattr(exc, "status_code", None) != 400:
                raise
            content = [
                *params["messages"][0]["content"],
                {"type": "text", "text": f"Give your answer by calling the tool `{TOOL_NAME}` once."},
            ]
            message = self._sdk.messages.create(
                **{**params, "messages": [{"role": "user", "content": content}]},
                tools=[tool],
                tool_choice={"type": "auto"},
            )
        _check_stop(message)
        block = next(
            (b for b in getattr(message, "content", []) or [] if getattr(b, "type", None) == "tool_use"),
            None,
        )
        if block is None:
            raise LLMError("the model did not return the structured answer")
        raw = block.input if isinstance(block.input, dict) else json.loads(block.input)
        try:
            return response_model.model_validate(raw), _usage(message)
        except ValidationError as exc:
            raise LLMError(f"the answer did not match the schema: {exc.errors()[:3]}") from exc


def default_client() -> LLMClient:
    """The process-wide client built from the configured provider's key."""
    global _default_client
    with _model_lock:
        if _default_client is None:
            _default_client = LLMClient()
        return _default_client


def call(
    prompt_name: str,
    version: str,
    content_blocks: list[dict[str, Any]],
    response_model: type[BaseModel],
    max_tokens: int = DEFAULT_MAX_TOKENS,
    sdk: Any | None = None,
) -> tuple[BaseModel, dict[str, int]]:
    """Module-level form of LLMClient.call; `sdk` injects an SDK object (tests)."""
    client = LLMClient(sdk) if sdk is not None else default_client()
    return client.call(prompt_name, version, content_blocks, response_model, max_tokens)
