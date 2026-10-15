from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Response
from sqlalchemy import select

from fdre_platform.api import schemas
from fdre_platform.api.deps import ActorDep, SessionDep, SettingsDep, StorageDep
from fdre_platform.models import Job, RunArtifact
from fdre_platform.services import runs

router = APIRouter(prefix="/orgs/{org_id}", tags=["runs"])


def job_out(job: Job | None) -> schemas.JobOut | None:
    return schemas.JobOut.model_validate(job, from_attributes=True) if job else None


def run_out(session, run, include_result: bool = True) -> schemas.RunOut:
    job = session.get(Job, run.job_id) if run.job_id else None
    data = schemas.RunOut(
        id=run.id, tender_id=run.tender_id, scenario_id=run.scenario_id, input_version_id=run.input_version_id, kind=run.kind, status=run.status,
        snapshot=run.snapshot, metrics=run.metrics, error=run.error, stale=run.stale, stale_reason=run.stale_reason, supersedes_run_id=run.supersedes_run_id,
        job=job_out(job), created_at=run.created_at, created_by=run.created_by, started_at=run.started_at, finished_at=run.finished_at,
        result=run.result if include_result else None,
    )
    return data


@router.post("/scenarios/{scenario_id}/runs", response_model=schemas.RunOut, status_code=202)
def launch_run(scenario_id: str, body: schemas.RunLaunchIn, session: SessionDep, settings: SettingsDep, actor: ActorDep, idempotency_key: str | None = Header(default=None)) -> schemas.RunOut:
    run, _ = runs.launch(session, settings, actor, scenario_id, kind=body.kind, solver_settings=body.solver_settings, idempotency_key=idempotency_key, supersedes_run_id=body.supersedes_run_id)
    session.commit()
    return run_out(session, run)


@router.get("/runs/{run_id}", response_model=schemas.RunOut)
def get_run(run_id: str, session: SessionDep, actor: ActorDep, include_result: bool = True) -> schemas.RunOut:
    return run_out(session, runs.get(session, actor, run_id), include_result=include_result)


@router.post("/runs/{run_id}/cancel", response_model=schemas.RunOut)
def cancel_run(run_id: str, session: SessionDep, actor: ActorDep) -> schemas.RunOut:
    run = runs.cancel(session, actor, run_id)
    session.commit()
    return run_out(session, run, include_result=False)


@router.get("/runs/{run_id}/artifacts/{kind}")
def download_artifact(run_id: str, kind: str, session: SessionDep, actor: ActorDep, storage: StorageDep) -> Response:
    run = runs.get(session, actor, run_id)
    artifact = session.scalar(select(RunArtifact).where(RunArtifact.run_id == run.id, RunArtifact.kind == kind))
    if artifact is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": "artifact not found"})
    data = storage.get_for(actor.organization_id, artifact.storage_key)
    return Response(content=data, media_type=artifact.content_type, headers={"Content-Disposition": f'attachment; filename="{artifact.filename}"', "X-Content-SHA256": artifact.sha256})


@router.get("/jobs/{job_id}", response_model=schemas.JobOut)
def get_job(job_id: str, session: SessionDep, actor: ActorDep) -> schemas.JobOut:
    job = session.get(Job, job_id)
    if job is None or job.organization_id != actor.organization_id:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": "job not found"})
    return job_out(job)  # type: ignore[return-value]
