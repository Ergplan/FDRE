"""Pydantic I/O models for /api/v1."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class LoginIn(BaseModel):
    email: str
    password: str


class OrgOut(BaseModel):
    id: str
    slug: str
    name: str
    role: str
    permissions: list[str]


class MeOut(BaseModel):
    user_id: str
    email: str
    display_name: str
    organizations: list[OrgOut]


class LoginOut(BaseModel):
    token: str
    me: MeOut


class UserCreateIn(BaseModel):
    email: str
    display_name: str
    password: str = Field(min_length=8)
    role: str


class MemberOut(BaseModel):
    user_id: str
    email: str
    display_name: str
    role: str


class TenderIn(BaseModel):
    name: str
    procurer: str = ""
    tender_family: str = "fdre"
    reference: str | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)


class TenderPatchIn(BaseModel):
    expected_revision: int
    changes: dict[str, Any]


class TenderOut(BaseModel):
    id: str
    name: str
    procurer: str
    tender_family: str
    reference: str | None
    status: str
    engine_tender_id: str | None
    attributes: dict[str, Any]
    revision: int
    created_at: datetime
    created_by: str | None
    updated_at: datetime
    updated_by: str | None


class TenderMemberIn(BaseModel):
    user_id: str | None = None
    email: str | None = None


class ScenarioIn(BaseModel):
    name: str
    workflow: str = "bid_tariff"
    description: str = ""
    inputs: dict[str, Any] | None = None


class ScenarioPatchIn(BaseModel):
    expected_revision: int
    name: str | None = None
    description: str | None = None
    status: str | None = None


class InputsIn(BaseModel):
    expected_revision: int
    inputs: dict[str, Any]
    note: str = ""


class InputVersionOut(BaseModel):
    id: str
    version_no: int
    inputs_hash: str
    note: str
    changed_paths: list[str]
    created_at: datetime
    created_by: str | None
    inputs: dict[str, Any] | None = None


class ScenarioOut(BaseModel):
    id: str
    tender_id: str
    name: str
    workflow: str
    status: str
    description: str
    revision: int
    current_input_version: InputVersionOut | None
    latest_run_id: str | None
    created_at: datetime
    created_by: str | None
    updated_at: datetime
    updated_by: str | None


class RunLaunchIn(BaseModel):
    kind: str = "evaluate"
    solver_settings: dict[str, Any] = Field(default_factory=dict)
    supersedes_run_id: str | None = None


class JobOut(BaseModel):
    id: str
    kind: str
    status: str
    attempts: int
    max_attempts: int
    cancel_requested: bool
    progress: dict[str, Any]
    last_error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class RunOut(BaseModel):
    id: str
    tender_id: str
    scenario_id: str
    input_version_id: str
    kind: str
    status: str
    snapshot: dict[str, Any]
    metrics: dict[str, Any]
    error: str | None
    stale: bool
    stale_reason: str | None
    supersedes_run_id: str | None
    job: JobOut | None
    created_at: datetime
    created_by: str | None
    started_at: datetime | None
    finished_at: datetime | None
    result: dict[str, Any] | None = None


class AuditOut(BaseModel):
    id: str
    actor_user_id: str | None
    actor_label: str
    action: str
    object_type: str
    object_id: str
    object_version: int | None
    before: dict[str, Any] | None
    after: dict[str, Any] | None
    request_id: str | None
    at: datetime


class NotificationOut(BaseModel):
    id: str
    kind: str
    title: str
    body: str
    link: str | None
    object_type: str | None
    object_id: str | None
    read_at: datetime | None
    created_at: datetime


class ErrorOut(BaseModel):
    error: str
    message: str
    current_revision: int | None = None
    conflicts: list[str] | None = None
