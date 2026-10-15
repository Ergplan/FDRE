"""Profiles and supply configuration."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Form, UploadFile
from pydantic import BaseModel

from fdre_platform.api.deps import ActorDep, SessionDep, StorageDep
from fdre_platform.services import supply

router = APIRouter(prefix="/orgs/{org_id}", tags=["supply"])


def _profile(p, include_series: bool = False) -> dict[str, Any]:
    out = {
        "id": p.id, "name": p.name, "kind": p.kind, "technology": p.technology, "basis": p.basis, "capacity_basis": p.capacity_basis, "capacity_mw": p.capacity_mw, "measured_at": p.measured_at,
        "p_level": p.p_level, "timezone": p.timezone, "resolution_minutes": p.resolution_minutes, "year": p.year, "sha256": p.sha256, "source_sha256": p.source_sha256, "stats": p.stats,
        "report": p.report, "provenance": p.provenance, "note": p.note, "created_at": p.created_at, "created_by": p.created_by,
    }
    if include_series:
        out["hourly"] = p.hourly
    return out


class SupplyValidateIn(BaseModel):
    supply: dict[str, Any]
    base_project: dict[str, Any] | None = None


class SupplySaveIn(BaseModel):
    expected_revision: int
    supply: dict[str, Any]
    note: str = ""


@router.get("/supply/schema")
def schema(actor: ActorDep) -> dict[str, Any]:
    return supply.schema_description()


@router.get("/supply/template/{kind}")
def template(kind: str, actor: ActorDep, name: str = "New module", module_id: str = "m1") -> dict[str, Any]:
    return supply.module_template(kind, name, module_id)


@router.post("/profiles", status_code=201)
async def upload_profile(
    file: UploadFile, session: SessionDep, storage: StorageDep, actor: ActorDep,
    name: Annotated[str, Form()] = "", kind: Annotated[str, Form()] = "generation", technology: Annotated[str | None, Form()] = None, basis: Annotated[str, Form()] = "capacity_factor",
    capacity_basis: Annotated[str | None, Form()] = None, capacity_mw: Annotated[float | None, Form()] = None, measured_at: Annotated[str | None, Form()] = None, p_level: Annotated[str | None, Form()] = None,
    timezone: Annotated[str | None, Form()] = None, interval_minutes: Annotated[int | None, Form()] = None, start: Annotated[str | None, Form()] = None, leap_day: Annotated[str, Form()] = "drop",
    source: Annotated[str, Form()] = "", note: Annotated[str, Form()] = "",
) -> dict[str, Any]:
    data = await file.read()
    profile, report = supply.store_profile(
        session, storage, actor, name=name or (file.filename or "profile"), filename=file.filename or "profile.csv", data=data, kind=kind, technology=technology, basis=basis, capacity_basis=capacity_basis,
        capacity_mw=capacity_mw, measured_at=measured_at, p_level=p_level, timezone=timezone, interval_minutes=interval_minutes, start=start, leap_day=leap_day, provenance={"kind": "measured" if source else "user_entered", "source": source, "entered_by": actor.user_id}, note=note,
    )
    session.commit()
    return {"profile": _profile(profile), "report": report}


@router.get("/profiles")
def list_profiles(session: SessionDep, actor: ActorDep) -> list[dict[str, Any]]:
    return [_profile(p) for p in supply.list_profiles(session, actor)]


@router.get("/profiles/{profile_id}")
def get_profile(profile_id: str, session: SessionDep, actor: ActorDep, series: bool = False) -> dict[str, Any]:
    return _profile(supply.get_profile(session, actor, profile_id), include_series=series)


@router.post("/supply/validate")
def validate_supply(body: SupplyValidateIn, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    return supply.validate_config(session, actor, body.supply, body.base_project)


@router.put("/scenarios/{scenario_id}/supply")
def save_supply(scenario_id: str, body: SupplySaveIn, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    scenario, result = supply.save_config(session, actor, scenario_id, expected_revision=body.expected_revision, data=body.supply, note=body.note)
    session.commit()
    from .scenarios import scenario_out

    return {"scenario": scenario_out(session, scenario, include_inputs=False).model_dump(), "validation": result}


@router.get("/scenarios/{scenario_id}/supply")
def get_supply(scenario_id: str, session: SessionDep, actor: ActorDep) -> dict[str, Any]:
    from fdre_platform.services import scenarios

    scenario = scenarios.get(session, actor, scenario_id)
    current = scenarios.current_inputs(session, scenario)
    inputs = current.inputs if current else {}
    config = inputs.get("supply")
    if not config:
        return {"scenario_id": scenario.id, "revision": scenario.revision, "supply": None, "validation": None}
    return {"scenario_id": scenario.id, "revision": scenario.revision, "supply": config, "validation": supply.validate_config(session, actor, config, inputs.get("project"))}
