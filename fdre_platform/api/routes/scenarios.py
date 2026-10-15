from __future__ import annotations

from fastapi import APIRouter

from fdre_platform.api import schemas
from fdre_platform.api.deps import ActorDep, SessionDep
from fdre_platform.services import runs, scenarios

router = APIRouter(prefix="/orgs/{org_id}", tags=["scenarios"])


def version_out(v, include_inputs: bool) -> schemas.InputVersionOut | None:
    if v is None:
        return None
    return schemas.InputVersionOut(id=v.id, version_no=v.version_no, inputs_hash=v.inputs_hash, note=v.note, changed_paths=list(v.changed_paths), created_at=v.created_at, created_by=v.created_by, inputs=v.inputs if include_inputs else None)


def scenario_out(session, s, include_inputs: bool = True) -> schemas.ScenarioOut:
    current = scenarios.current_inputs(session, s)
    return schemas.ScenarioOut(
        id=s.id, tender_id=s.tender_id, name=s.name, workflow=s.workflow, status=s.status, description=s.description, revision=s.revision,
        current_input_version=version_out(current, include_inputs), latest_run_id=s.latest_run_id,
        created_at=s.created_at, created_by=s.created_by, updated_at=s.updated_at, updated_by=s.updated_by,
    )


@router.get("/tenders/{tender_id}/scenarios", response_model=list[schemas.ScenarioOut])
def list_scenarios(tender_id: str, session: SessionDep, actor: ActorDep) -> list[schemas.ScenarioOut]:
    return [scenario_out(session, s, include_inputs=False) for s in scenarios.list_for_tender(session, actor, tender_id)]


@router.post("/tenders/{tender_id}/scenarios", response_model=schemas.ScenarioOut, status_code=201)
def create_scenario(tender_id: str, body: schemas.ScenarioIn, session: SessionDep, actor: ActorDep) -> schemas.ScenarioOut:
    scenario = scenarios.create(session, actor, tender_id, name=body.name, workflow=body.workflow, description=body.description, inputs=body.inputs)
    session.commit()
    return scenario_out(session, scenario)


@router.get("/scenarios/{scenario_id}", response_model=schemas.ScenarioOut)
def get_scenario(scenario_id: str, session: SessionDep, actor: ActorDep) -> schemas.ScenarioOut:
    return scenario_out(session, scenarios.get(session, actor, scenario_id))


@router.patch("/scenarios/{scenario_id}", response_model=schemas.ScenarioOut)
def patch_scenario(scenario_id: str, body: schemas.ScenarioPatchIn, session: SessionDep, actor: ActorDep) -> schemas.ScenarioOut:
    scenario = scenarios.update(session, actor, scenario_id, expected_revision=body.expected_revision, name=body.name, description=body.description, status=body.status)
    session.commit()
    return scenario_out(session, scenario)


@router.put("/scenarios/{scenario_id}/inputs", response_model=schemas.ScenarioOut)
def save_inputs(scenario_id: str, body: schemas.InputsIn, session: SessionDep, actor: ActorDep) -> schemas.ScenarioOut:
    scenarios.save_inputs(session, actor, scenario_id, expected_revision=body.expected_revision, inputs=body.inputs, note=body.note)
    session.commit()
    return scenario_out(session, scenarios.get(session, actor, scenario_id))


@router.get("/scenarios/{scenario_id}/versions", response_model=list[schemas.InputVersionOut])
def list_versions(scenario_id: str, session: SessionDep, actor: ActorDep, include_inputs: bool = False) -> list[schemas.InputVersionOut]:
    return [version_out(v, include_inputs) for v in scenarios.versions(session, actor, scenario_id)]  # type: ignore[misc]


@router.get("/scenarios/{scenario_id}/runs", response_model=list[schemas.RunOut])
def scenario_runs(scenario_id: str, session: SessionDep, actor: ActorDep) -> list[schemas.RunOut]:
    from .runs import run_out

    return [run_out(session, r, include_result=False) for r in runs.list_for_scenario(session, actor, scenario_id)]
