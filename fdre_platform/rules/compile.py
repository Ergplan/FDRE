"""Compile a requirement version into executable rules. Extraction and rules are kept
apart: a requirement is what the document says; a rule is what the engine enforces. A rule
the engine cannot enforce is still listed, marked unsupported, and blocks certification."""

from __future__ import annotations

from typing import Any

from .catalog import BY_PATH, to_input_value

# What the current engine adapter (legacy FDRE dispatch) can enforce, by rule type.
ENGINE_CAPABILITIES: dict[str, dict[str, Any]] = {
    "capacity_bounds": {"supported": True, "engine": "ProjectConfig.validate: min_project_mw, max_bidder_capacity_mw, project_mw_multiple"},
    "ppa_term": {"supported": True, "engine": "TenderRules.ppa_years"},
    "peak_availability": {"supported": True, "engine": "monthly peak availability test, TenderRules.peak_availability_floor"},
    "peak_window": {"supported": True, "engine": "TenderRules.morning_window/evening_window and fixed peak hours", "note": "peak hours chosen by the buyer: fixed or worst-deficit mode; buyer-scheduled hours are approximated"},
    "cuf_band": {"supported": True, "engine": "annual CUF test on declared CUF with lower tolerance and upper multiplier"},
    "penalty": {"supported": True, "engine": "liquidated damages at penalty_multiplier x tariff on shortfall energy"},
    "external_sourcing": {"supported": True, "engine": "external green support up to external_green_limit_fraction at a configured price"},
    "storage_obligation": {"supported": True, "engine": "BESS present in portfolio; validate() warns when BESS power is below the peak floor"},
    "charging_source": {"supported": "re_only", "engine": "RE-only co-located charging is the only dispatch mode", "note": "grid or market charging is not modelled: a rule that allows it is unsupported and a rule that requires RE-only charging is satisfied by construction"},
    "excess_energy": {"supported": ("ppa_tariff", "not_purchased"), "engine": "surplus beyond the annual cap sold merchant at the configured price", "note": "pct_of_tariff and fixed excess prices are not modelled"},
    "merchant_sales": {"supported": True, "engine": "merchant price with haircut"},
    "tariff_ceiling": {"supported": True, "engine": "checked after the tariff search; not an optimisation constraint"},
    "re_share": {"supported": False, "engine": None, "note": "the engine has no RE-share accounting across sources; Day 4 formulation"},
    "source_eligibility": {"supported": False, "engine": None, "note": "thermal/biomass/market sources arrive with the Day 3 modules and the Day 4 formulation"},
}


def compile_rules(requirements: list[dict[str, Any]]) -> dict[str, Any]:
    """requirements: rows with field_path, value, unit, review_state, id. Returns the rule
    list, counts and whether the set certifies (no unsupported rule, no unreviewed rule
    feeding the engine, every required field present)."""
    by_path = {r["field_path"]: r for r in requirements}
    rules: list[dict[str, Any]] = []
    for path, req in by_path.items():
        fdef = BY_PATH.get(path)
        if fdef is None or fdef.rule_type is None:
            continue
        if req.get("review_state") == "rejected" or req.get("value") is None:
            continue
        cap = ENGINE_CAPABILITIES.get(fdef.rule_type, {"supported": False})
        supported, reason = _supported(fdef.rule_type, cap, req.get("value"), path)
        rules.append(
            {
                "rule_id": f"{fdef.rule_type}:{path}",
                "rule_type": fdef.rule_type,
                "field_path": path,
                "requirement_id": req.get("id"),
                "label": fdef.label,
                "value": req.get("value"),
                "unit": fdef.unit,
                "engine_input": fdef.input_path,
                "engine_value": to_input_value(fdef, req.get("value")) if fdef.input_path and fdef.value_type not in ("record", "record_list", "long_text", "text") else None,
                "constraint": fdef.constraint,
                "supported": supported,
                "engine": cap.get("engine"),
                "reason": reason,
                "reviewed": req.get("review_state") in ("accepted", "corrected"),
                "evidence": req.get("evidence"),
            }
        )
    required_missing = [f.path for f in BY_PATH.values() if f.required and (f.path not in by_path or by_path[f.path].get("value") is None)]
    unsupported = [r for r in rules if not r["supported"]]
    unreviewed = [r for r in rules if not r["reviewed"]]
    return {
        "rules": rules,
        "unsupported_count": len(unsupported),
        "unreviewed_count": len(unreviewed),
        "required_missing": required_missing,
        "certifiable": not unsupported and not unreviewed and not required_missing,
        "blocking": [f"unsupported rule {r['rule_id']}: {r['reason']}" for r in unsupported]
        + [f"unreviewed rule {r['rule_id']}" for r in unreviewed]
        + [f"required requirement missing: {p}" for p in required_missing],
    }


def _supported(rule_type: str, cap: dict[str, Any], value: Any, path: str = "") -> tuple[bool, str | None]:
    sup = cap.get("supported", False)
    if sup is True:
        return True, None
    if sup is False:
        return False, cap.get("note") or "not implemented by the engine"
    if rule_type == "charging_source":
        if path.endswith("co_located_required"):
            return True, None  # storage is co-located with its node's RE in the model either way
        if value is True:
            return True, None
        return False, cap.get("note")
    if rule_type == "excess_energy":
        if value in sup:
            return True, None
        return False, cap.get("note")
    return False, cap.get("note")
