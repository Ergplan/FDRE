"""Job handlers. `run` executes a Run with the engine and writes the immutable result.
Day 4 replaces the legacy evaluate/optimize bodies with the MILP formulation; the job,
snapshot and status contract stays."""

from __future__ import annotations

import math
import time
import traceback
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from fdre_platform.config import Settings
from fdre_platform.models import Run, RunArtifact
from fdre_platform.services import audit
from fdre_platform.services.context import system_actor
from fdre_platform.storage import LocalStorage

Heartbeat = Callable[[dict[str, Any] | None], bool]


class RunCancelled(Exception):
    pass


def _engine_modules():  # imported lazily: the engine pulls numpy/pandas/scipy
    import fdre_enterprise_engine as E
    from react_demo.backend import api as legacy

    return E, legacy


def execute_run(session: Session, settings: Settings, storage: LocalStorage, run_id: str, heartbeat: Heartbeat) -> None:
    run = session.get(Run, run_id)
    if run is None:
        raise LookupError(f"run {run_id} does not exist")
    if run.status in ("cancelled",):
        return
    if run.status != "running":
        run.status = "running"
        run.started_at = datetime.now(UTC)
        session.commit()
    if not heartbeat({"phase": "loading"}):
        _finish(session, run, "cancelled", None, {"runtime_seconds": 0.0}, "cancelled before start")
        return
    started = time.perf_counter()
    try:
        result, metrics, status = _run_engine(run, heartbeat)
    except RunCancelled:
        _finish(session, run, "cancelled", None, {"runtime_seconds": time.perf_counter() - started}, "cancelled by request")
        return
    except Exception:
        _finish(session, run, "failed", None, {"runtime_seconds": time.perf_counter() - started}, traceback.format_exc()[-4000:])
        raise
    metrics["runtime_seconds"] = round(time.perf_counter() - started, 3)
    metrics["artifact_hashes"] = _write_artifacts(session, storage, run, result)
    _finish(session, run, status, result, metrics, None)


def _finish(session: Session, run: Run, status: str, result: dict[str, Any] | None, metrics: dict[str, Any], error: str | None) -> None:
    run.status = status
    run.result = result
    run.metrics = {**run.metrics, **metrics}
    run.error = error
    run.finished_at = datetime.now(UTC)
    session.flush()
    audit.record(session, system_actor(run.organization_id, "worker"), "run.finish", "run", run.id, after={"status": status, "metrics": run.metrics, "error": (error or "")[:500] or None}, tender_id=run.tender_id)
    session.commit()


def _run_engine(run: Run, heartbeat: Heartbeat) -> tuple[dict[str, Any], dict[str, Any], str]:
    E, legacy = _engine_modules()
    inputs = run.snapshot and _inputs_of(run)
    options = {**(inputs.get("run_options", {}) if isinstance(inputs, dict) else {}), **((run.snapshot or {}).get("solver_settings") or {})}
    project = legacy._project_from_payload(inputs.get("project"))
    years = legacy._years(options.get("years_mode", "fast"), project)
    custom_cf = _custom_cf(inputs, legacy, options)
    if not heartbeat({"phase": "dispatch", "years": list(years)}):
        raise RunCancelled()
    if run.kind == "evaluate":
        result = E.evaluate_project(project, years=years, custom_cf=custom_cf)
        response = legacy._response(project, result, custom_cf is not None, options.get("wind_p_level", "P50"))
        response["mode"] = "fixed_sizing"
        response["first_year"] = {**response.get("first_year", {}), "generation_by_asset": _generation_by_asset(result.get("first_year_dispatch"), project, E)}
        extra: dict[str, Any] = {}
    elif run.kind == "optimize":
        bounds = {k: tuple(v) for k, v in (options.get("bounds") or {}).items()} or None
        if bounds is None:
            cap = E.project_capacity_summary(project)
            bounds = {
                "wind_mw": (max(0.0, cap["wind_mw"] * 0.5), max(10.0, cap["wind_mw"] * 2.0)),
                "solar_ac_mw": (max(0.0, cap["solar_ac_mw"] * 0.75), min(800.0, cap["solar_ac_mw"] * 1.5)),
                "bess_power_mw": (0.0, min(500.0, max(cap["bess_power_mw"] * 1.5, project.tender.contracted_capacity_mw * 1.25))),
                "bess_energy_mwh": (0.0, min(2000.0, max(cap["bess_energy_mwh"] * 1.5, project.tender.contracted_capacity_mw * 5.0))),
                "contracted_capacity_mw": (project.tender.contracted_capacity_mw, project.tender.contracted_capacity_mw),
            }
        effort = options.get("effort", "fast")
        project.simulation.circular_soc_iterations = 1
        result = E.optimize_capacity(project, bounds, years=years, maxiter=0 if effort == "fast" else 1, popsize=1, seed=project.simulation.seed, polish=effort != "fast", custom_cf=custom_cf, fixed_bess_duration_hours=options.get("fixed_bess_duration_hours"))
        response = legacy._response(result["project"], result, custom_cf is not None, options.get("wind_p_level", "P50"))
        response["optimizer"] = legacy._clean(result.get("optimizer", {}))
        response["mode"] = "capacity_search_legacy"
        extra = {"solver": "highs_lp_seed+candidate_search", "optimality": "screening (not certified)", "gap": None}
    elif run.kind in ("bid_tariff", "fixed_tariff", "milp_dispatch"):
        from sqlalchemy.orm import object_session

        from . import runs_milp

        session = object_session(run)
        assert session is not None
        response, extra, status = runs_milp.execute(run.kind, inputs, options, session=session, organization_id=run.organization_id, heartbeat=heartbeat)
        if status == "cancelled":
            raise RunCancelled()
        metrics = {"status_reason": extra.pop("status_reason", status), "years_simulated": list(years), **extra}
        return response, metrics, status
    else:
        raise ValueError(f"run kind {run.kind} has no handler yet")
    tariff = response.get("tariff")
    reason = (response.get("status") or {}).get("reason", "ok")
    if tariff is None or (isinstance(tariff, float) and not math.isfinite(tariff)):
        status = "infeasible"
    else:
        status = "succeeded"
    metrics = {"status_reason": reason, "tariff_rs_per_kwh": tariff, "years_simulated": list(years), **extra}
    return response, metrics, status


def _custom_cf(inputs: dict[str, Any], legacy: Any, options: dict[str, Any]) -> Any:
    """Profile columns compiled from the supply configuration (Day 3) take precedence over
    the legacy wind CSV path."""
    compiled = (inputs.get("supply_compiled") or {}).get("custom_cf") or {}
    if compiled:
        import pandas as pd

        return pd.DataFrame({k: list(v) for k, v in compiled.items()})
    return legacy._custom_wind_cf(bool(options.get("use_wind_profile", False)), options.get("wind_p_level", "P50"))


def _generation_by_asset(first: Any, project: Any, E: Any) -> dict[str, float]:
    """First-year energy per generator at the engine's generation boundary (after availability
    and before the POI deduction), for reconciliation against the loss chain."""
    if first is None or getattr(first, "hourly", None) is None or first.hourly is None:
        return {}
    out: dict[str, float] = {}
    for gen in project.generators:
        col = f"gen_{E._safe_name(gen.name)}"
        if col in first.hourly.columns:
            out[gen.name] = float(first.hourly[col].sum())
    return out


def _inputs_of(run: Run) -> dict[str, Any]:
    from sqlalchemy.orm import object_session

    from fdre_platform.models import ScenarioInputVersion

    session = object_session(run)
    assert session is not None
    version = session.get(ScenarioInputVersion, run.input_version_id)
    assert version is not None
    return dict(version.inputs)


def _write_artifacts(session: Session, storage: LocalStorage, run: Run, result: dict[str, Any] | None) -> dict[str, str]:
    """Store the result file before the run is closed; the hash goes into the run's metrics."""
    if not result:
        return {}
    import json

    payload = json.dumps({"run_id": run.id, "snapshot": run.snapshot, "result": result}, default=str, sort_keys=True).encode()
    stored = storage.put(run.organization_id, f"runs/{run.id}", "result.json", payload)
    session.add(RunArtifact(organization_id=run.organization_id, run_id=run.id, kind="result_json", filename="result.json", content_type="application/json", sha256=stored.sha256, size_bytes=stored.size_bytes, storage_key=stored.key, created_by=None))
    session.flush()
    return {"result.json": stored.sha256}
