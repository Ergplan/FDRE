"""Settings from environment variables. `.env.example` lists every variable."""

from __future__ import annotations

import pathlib

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "postgresql+psycopg://fdre:fdre@127.0.0.1:5432/fdre"
    data_dir: pathlib.Path = REPO_ROOT / "data"
    session_ttl_hours: int = 24 * 14
    secure_cookies: bool = False
    # Worker
    worker_poll_seconds: float = 1.0
    job_lease_seconds: int = 600
    # tender_engine integration (see fdre_platform/integrations/tender_engine.py)
    tender_engine_url: str = ""
    tender_engine_reviewer: str = "fdre-platform"
    tender_engine_admin_token: str = ""
    # When no live tender_engine is configured the adapter answers from recorded fixtures,
    # and every such answer is labelled source="fixture".
    tender_engine_fixtures: bool = True
    # Versions stamped on every run snapshot.
    engine_version: str = "fdre_enterprise_engine@legacy-greedy-1"
    finance_version: str = "financial_model@legacy-1"
    rules_version: str = "nhpc_fdre_rules@legacy-1"
    # Assistant and RealTalk voice (Day 6). The provider key never leaves the server. With no
    # key (or assistant_provider=recorded) the deterministic recorded model answers and every
    # message is labelled provider="recorded".
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    openai_chat_model: str = "gpt-5"
    openai_realtime_model: str = "gpt-realtime"
    assistant_provider: str = "auto"          # auto | openai | recorded
    assistant_fixture: pathlib.Path = REPO_ROOT / "tests" / "fixtures" / "assistant" / "recorded.json"
    assistant_action_ttl_minutes: int = 30
    voice_session_ttl_minutes: int = 15


def get_settings() -> Settings:
    return Settings()
