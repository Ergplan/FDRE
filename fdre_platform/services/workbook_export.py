"""Export the formula workbook of a finance-bearing run as an immutable run artifact."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from fdre_platform.finance import workbook
from fdre_platform.finance.model import CapexItem, FinanceAssumptions, OpexItem, OperatingYear, evaluate
from fdre_platform.models import RunArtifact, Scenario, Tender
from fdre_platform.optimization.search import operating_years
from fdre_platform.storage import LocalStorage

from . import audit, runs
from .context import Actor
from .tenders import ValidationFailed


def _assumptions(d: dict[str, Any]) -> FinanceAssumptions:
    a = FinanceAssumptions(
        ppa_years=int(d["ppa_years"]), capex=[CapexItem(c["name"], float(c["amount_inr"]), c.get("tax_block", "wdv_eligible"), c.get("source", "")) for c in d["capex"]],
        opex=[OpexItem(o["name"], float(o["amount_inr_per_year"]), float(o.get("escalation", 0.0)), int(o.get("start_year", 1)), o.get("source", "")) for o in d["opex"]],
        debt_fraction=float(d["debt_fraction"]), interest_rate=float(d["interest_rate"]), tenor_years=int(d["tenor_years"]), repayment=d.get("repayment", "sculpted"), sculpt_target_dscr=float(d["sculpt_target_dscr"]),
        tax_rate=float(d["tax_rate"]), tax_wdv_rate=float(d["tax_wdv_rate"]), discount_rate=float(d["discount_rate"]), target_equity_irr=float(d["target_equity_irr"]), min_dscr=float(d["min_dscr"]), sources=d.get("sources", {}),
        augmentation=[(int(y), float(amt)) for y, amt in d.get("augmentation", [])],
    )
    return a


def export(session: Session, storage: LocalStorage, actor: Actor, run_id: str, *, verify: bool = True) -> tuple[RunArtifact, dict[str, Any]]:
    run = runs.get(session, actor, run_id)
    result = run.result or {}
    if not result.get("finance") or not result.get("assumptions") or not result.get("term"):
        raise ValidationFailed("this run has no finance result to export (run a fixed-tariff evaluation or a bid tariff search)")
    a = _assumptions(result["assumptions"])
    ops: list[OperatingYear] = operating_years(result["term"]["per_year"])
    tariff = float(result["tariff"])
    tender = session.get(Tender, run.tender_id)
    scenario = session.get(Scenario, run.scenario_id)
    tparams = run.snapshot.get("solver_settings", {})
    project = (run.snapshot or {}).get("tender_params") or {}
    psm = float(project.get("psm", 0.0)) if project else float(result.get("psm", 0.02))
    penalty = float(project.get("penalty_multiplier", 1.5)) if project else 1.5
    fin = evaluate(a, ops, tariff, psm_charge_inr_per_kwh=psm, penalty_multiplier=penalty)
    provenance = {
        "run_id": run.id, "scenario_name": scenario.name if scenario else run.scenario_id, "tender_name": tender.name if tender else run.tender_id, "inputs_hash": run.snapshot.get("inputs", {}).get("hash"), "rules_version": run.snapshot.get("rules_version"),
        "solver": run.metrics.get("solver"), "tariff_source": "bid tariff search" if run.kind == "bid_tariff" else "entered tariff", "sensitivities": result.get("sensitivities", []), "settings": tparams,
    }
    data = workbook.build(a, ops, fin, provenance=provenance, tariff=tariff, psm=psm, penalty_multiplier=penalty)
    stored = storage.put(actor.organization_id, f"runs/{run.id}", f"financial-model-{run.id[:8]}.xlsx", data)
    artifact = RunArtifact(organization_id=actor.organization_id, run_id=run.id, kind="financial_model_xlsx", filename=f"financial-model-{run.id[:8]}.xlsx", content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sha256=stored.sha256, size_bytes=stored.size_bytes, storage_key=stored.key, created_by=actor.user_id)
    session.add(artifact)
    session.flush()
    verdict = workbook.verify(data, fin) if verify else {"status": "not_verified", "comparisons": []}
    audit.record(session, actor, "run.workbook_export", "run", run.id, after={"artifact_id": artifact.id, "sha256": stored.sha256, "verification": verdict.get("status"), "comparisons": verdict.get("comparisons")}, tender_id=run.tender_id)
    return artifact, verdict
