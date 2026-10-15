"""The tool registry. Every tool runs as the signed-in user through the same services the
API uses, so organisation scope, tender membership and permissions are enforced on the
server. Read tools execute immediately; mutating tools only produce a proposal that the
same user must confirm. There is no delete, shell, SQL or cross-organisation tool, and
nothing in this module reads instructions from documents."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Any

from sqlalchemy.orm import Session

from fdre_platform.config import Settings
from fdre_platform.services import amendments, collaboration, history, requirements, runs, scenarios, summary, tenders
from fdre_platform.services.context import Actor, PermissionDenied
from fdre_platform.services.tenders import Conflict, NotFound, ValidationFailed
from fdre_platform.storage import LocalStorage


class ToolError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class ToolContext:
    session: Session
    settings: Settings
    storage: LocalStorage
    actor: Actor
    tender_id: str | None = None


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]
    permission: str
    mutating: bool
    handler: Callable[[ToolContext, dict[str, Any]], Any]
    preview: Callable[[ToolContext, dict[str, Any]], str] | None = None


REGISTRY: dict[str, ToolSpec] = {}
MAX_STRING = 4000
# Names a compromised or confused model might ask for. They never exist here; the test
# suite asserts they are refused with `unknown_tool` and audited.
NEVER_TOOLS = ("delete_scenario", "delete_run", "delete_tender", "run_sql", "execute_sql", "shell", "run_command", "approve_bid", "grant_permission", "switch_organization")


def tool(name: str, description: str, parameters: dict[str, Any], *, permission: str, mutating: bool = False, preview: Callable[[ToolContext, dict[str, Any]], str] | None = None):
    def register(fn: Callable[[ToolContext, dict[str, Any]], Any]) -> Callable[[ToolContext, dict[str, Any]], Any]:
        if name in REGISTRY:
            raise RuntimeError(f"tool {name} registered twice")
        REGISTRY[name] = ToolSpec(name=name, description=description, parameters={"type": "object", "properties": parameters.get("properties", {}), "required": parameters.get("required", []), "additionalProperties": False}, permission=permission, mutating=mutating, handler=fn, preview=preview)
        return fn

    return register


def _s(desc: str, **extra: Any) -> dict[str, Any]:
    return {"type": "string", "description": desc, **extra}


def _n(desc: str) -> dict[str, Any]:
    return {"type": "number", "description": desc}


def validate_arguments(spec: ToolSpec, args: Any) -> dict[str, Any]:
    if not isinstance(args, dict):
        raise ToolError("invalid_arguments", "arguments must be an object")
    props = spec.parameters["properties"]
    unknown = sorted(set(args) - set(props))
    if unknown:
        raise ToolError("invalid_arguments", f"unknown arguments: {', '.join(unknown)}")
    missing = [k for k in spec.parameters["required"] if args.get(k) in (None, "")]
    if missing:
        raise ToolError("invalid_arguments", f"missing arguments: {', '.join(missing)}")
    out: dict[str, Any] = {}
    for key, value in args.items():
        if value is None:
            continue
        t = props[key].get("type")
        if t == "string":
            if not isinstance(value, str):
                raise ToolError("invalid_arguments", f"{key} must be a string")
            if len(value) > MAX_STRING:
                raise ToolError("invalid_arguments", f"{key} is too long")
            if "enum" in props[key] and value not in props[key]["enum"]:
                raise ToolError("invalid_arguments", f"{key} must be one of {', '.join(props[key]['enum'])}")
        elif t == "number":
            if isinstance(value, bool) or not isinstance(value, int | float):
                raise ToolError("invalid_arguments", f"{key} must be a number")
        elif t == "integer":
            if isinstance(value, bool) or not isinstance(value, int):
                raise ToolError("invalid_arguments", f"{key} must be an integer")
        elif t == "boolean":
            if not isinstance(value, bool):
                raise ToolError("invalid_arguments", f"{key} must be true or false")
        out[key] = value
    return out


def specs_for(actor: Actor) -> list[ToolSpec]:
    return [s for s in REGISTRY.values() if actor.can(s.permission)]


def openai_tools(actor: Actor) -> list[dict[str, Any]]:
    return [{"type": "function", "function": {"name": s.name, "description": s.description + (" Requires confirmation by the user before anything changes." if s.mutating else ""), "parameters": s.parameters}} for s in specs_for(actor)]


def realtime_tools(actor: Actor) -> list[dict[str, Any]]:
    return [{"type": "function", "name": s.name, "description": s.description, "parameters": s.parameters} for s in specs_for(actor)]


def resolve(name: str) -> ToolSpec:
    spec = REGISTRY.get(name)
    if spec is None:
        raise ToolError("unknown_tool", f"tool {name!r} is not available")
    return spec


def _translate(exc: Exception) -> ToolError:
    if isinstance(exc, PermissionDenied):
        return ToolError("forbidden", str(exc))
    if isinstance(exc, NotFound):
        return ToolError("not_found", f"{exc} not found")
    if isinstance(exc, Conflict):
        return ToolError("conflict", str(exc))
    if isinstance(exc, ValidationFailed):
        return ToolError("validation", str(exc))
    return ToolError("failed", f"{type(exc).__name__}: {exc}")


def invoke_read(ctx: ToolContext, name: str, args: Any) -> Any:
    """Execute a read tool now. Mutating tools are refused here by design."""
    spec = resolve(name)
    clean = validate_arguments(spec, args)
    if spec.mutating:
        raise ToolError("confirmation_required", f"{name} changes data and needs the user's confirmation")
    if not ctx.actor.can(spec.permission):
        raise ToolError("forbidden", f"permission {spec.permission} required")
    try:
        return spec.handler(ctx, clean)
    except (PermissionDenied, NotFound, Conflict, ValidationFailed) as exc:
        raise _translate(exc) from exc


def preview_mutation(ctx: ToolContext, name: str, args: Any) -> tuple[ToolSpec, dict[str, Any], str]:
    """Validate a proposed mutation as the acting user: permission, organisation scope and
    the existence of its targets, without changing anything."""
    spec = resolve(name)
    clean = validate_arguments(spec, args)
    if not spec.mutating:
        raise ToolError("invalid_arguments", f"{name} is a read tool")
    if not ctx.actor.can(spec.permission):
        raise ToolError("forbidden", f"permission {spec.permission} required")
    try:
        text = spec.preview(ctx, clean) if spec.preview else f"{name} {clean}"
    except (PermissionDenied, NotFound, Conflict, ValidationFailed) as exc:
        raise _translate(exc) from exc
    return spec, clean, text


def execute_mutation(ctx: ToolContext, name: str, args: dict[str, Any]) -> Any:
    spec = resolve(name)
    clean = validate_arguments(spec, args)
    if not spec.mutating:
        raise ToolError("invalid_arguments", f"{name} is a read tool")
    ctx.actor.require(spec.permission)
    try:
        return spec.handler(ctx, clean)
    except (PermissionDenied, NotFound, Conflict, ValidationFailed) as exc:
        raise _translate(exc) from exc


# ----------------------------------------------------------------------------- read tools


@tool("list_tenders", "List the tenders the user can work in.", {}, permission="tender.read")
def list_tenders(ctx: ToolContext, args: dict[str, Any]) -> Any:
    return [{"id": t.id, "name": t.name, "procurer": t.procurer, "family": t.tender_family, "status": t.status, "reference": t.reference} for t in tenders.visible(ctx.session, ctx.actor)]


@tool("get_tender_summary", "The current reviewed requirements of a tender: key values with units, review state and evidence page, missing items and bid risks.", {"properties": {"tender_id": _s("tender id")}, "required": ["tender_id"]}, permission="tender.read")
def get_tender_summary(ctx: ToolContext, args: dict[str, Any]) -> Any:
    tender = tenders.get(ctx.session, ctx.actor, args["tender_id"])
    version = requirements.current_version(ctx.session, tender)
    if version is None:
        return {"tender": tender.name, "requirements": None, "note": "no requirement version yet; upload and extract the tender documents first"}
    s = summary.build(ctx.session, version)
    items = [
        {"field": i["field_path"], "label": i["label"], "value": i["value"], "unit": i["unit"], "review_state": i["review_state"], "page": (i["evidence"] or {}).get("page")}
        for g in s["groups"]
        for i in g["items"]
    ]
    return {"tender": tender.name, "requirement_version": {"id": version.id, "version_no": version.version_no, "status": version.status}, "items": items, "missing_information": s["missing_information"], "bid_risks": s["bid_risks"][:20]}


@tool("list_scenarios", "List the scenarios of a tender with their revision and latest run.", {"properties": {"tender_id": _s("tender id")}, "required": ["tender_id"]}, permission="tender.read")
def list_scenarios(ctx: ToolContext, args: dict[str, Any]) -> Any:
    return [{"id": s.id, "name": s.name, "workflow": s.workflow, "status": s.status, "revision": s.revision, "latest_run_id": s.latest_run_id} for s in scenarios.list_for_tender(ctx.session, ctx.actor, args["tender_id"])]


def _inputs_overview(inputs: dict[str, Any]) -> dict[str, Any]:
    supply = inputs.get("supply") or {}
    mods = []
    for m in supply.get("modules", []):
        caps = {k: m.get(k) for k in ("mwac", "mwp_dc", "installed_mw", "capacity_mw", "power_mw", "energy_mwh") if m.get(k) is not None}
        mods.append({"name": m.get("name"), "kind": m.get("kind"), **caps})
    project = inputs.get("project") or {}
    return {"supply_modules": mods, "settings": inputs.get("settings") or {}, "run_options": inputs.get("run_options") or {}, "contracted_capacity_mw": (project.get("tender") or {}).get("contracted_capacity_mw")}


@tool("get_scenario", "A scenario's current inputs overview (supply modules and capacities, settings, run options), its revision and inputs hash.", {"properties": {"scenario_id": _s("scenario id")}, "required": ["scenario_id"]}, permission="tender.read")
def get_scenario(ctx: ToolContext, args: dict[str, Any]) -> Any:
    sc = scenarios.get(ctx.session, ctx.actor, args["scenario_id"])
    v = scenarios.current_inputs(ctx.session, sc)
    return {"id": sc.id, "name": sc.name, "workflow": sc.workflow, "status": sc.status, "revision": sc.revision, "inputs_hash": v.inputs_hash if v else None, "inputs": _inputs_overview(v.inputs) if v else {}}


@tool("list_runs", "List the runs of a tender with status, staleness and headline metrics.", {"properties": {"tender_id": _s("tender id")}, "required": ["tender_id"]}, permission="tender.read")
def list_runs(ctx: ToolContext, args: dict[str, Any]) -> Any:
    out = []
    for r in runs.list_for_tender(ctx.session, ctx.actor, args["tender_id"])[:25]:
        m = r.metrics or {}
        out.append({"id": r.id, "scenario_id": r.scenario_id, "kind": r.kind, "status": r.status, "stale": r.stale, "created_at": r.created_at.isoformat(), "tariff": m.get("tariff"), "equity_irr": m.get("equity_irr"), "min_dscr": m.get("min_dscr"), "certified": m.get("certified")})
    return out


@tool("get_run_result", "The result of one run: classification, tariff, finance KPIs, solved years, validation status and binding constraints.", {"properties": {"run_id": _s("run id")}, "required": ["run_id"]}, permission="tender.read")
def get_run_result(ctx: ToolContext, args: dict[str, Any]) -> Any:
    r = runs.get(ctx.session, ctx.actor, args["run_id"])
    res = r.result or {}
    fin = res.get("finance") or {}
    term = res.get("term") or {}
    return {
        "id": r.id, "kind": r.kind, "status": r.status, "stale": r.stale, "stale_reason": r.stale_reason, "error": r.error, "metrics": r.metrics,
        "tariff": res.get("tariff"), "tariff_label": res.get("tariff_label"), "search_status": res.get("search_status"), "certification_boundary": res.get("certification_boundary"),
        "finance": {k: fin.get(k) for k in ("version", "equity_irr", "project_irr", "npv_equity_cr", "min_dscr", "avg_dscr", "total_project_cost_cr", "debt_cr", "equity_cr")} if fin else None,
        "term": {"status": term.get("status"), "years_solved": term.get("years_solved"), "validation": (term.get("certification_year1") or {}).get("status")} if term else None,
        "binding": res.get("binding"), "inputs_hash": (r.snapshot.get("inputs") or {}).get("hash"), "rules_version": r.snapshot.get("rules_version"),
    }


@tool(
    "historical_comparables",
    "Comparable historical awards from the shared results snapshot, each with the reason it is similar, its units and its source. Only INR/kWh awarded or adopted tariffs are returned as comparable tariffs.",
    {"properties": {"tender_family": _s("fdre | hybrid | solar | wind | bess | solar_storage"), "capacity_mw": _n("capacity in MW"), "storage": {"type": "boolean", "description": "with storage or firmness conditions"}, "procurer": _s("procurer name"), "limit": {"type": "integer", "description": "max rows (default 8)"}}},
    permission="tender.read",
)
def historical_comparables(ctx: ToolContext, args: dict[str, Any]) -> Any:
    rows = history.comparables(ctx.session, tender_family=args.get("tender_family"), procurer=args.get("procurer"), capacity_mw=args.get("capacity_mw"), storage=args.get("storage"), limit=min(int(args.get("limit") or 8), 25), tariff_only=True)
    return [{k: r.get(k) for k in ("procurer", "tender_title", "bidder", "capacity", "capacity_unit", "price", "price_unit", "result_kind", "award_date", "why_similar", "source_url", "source_page")} for r in rows]


@tool("list_my_tasks", "The user's open review tasks, optionally for one tender.", {"properties": {"tender_id": _s("tender id")}}, permission="tender.read")
def list_my_tasks(ctx: ToolContext, args: dict[str, Any]) -> Any:
    return [{"id": t.id, "tender_id": t.tender_id, "kind": t.kind, "title": t.title, "status": t.status, "due_on": t.due_on.isoformat() if t.due_on else None} for t in amendments.tasks_for(ctx.session, ctx.actor, tender_id=args.get("tender_id"), mine=True, status="open")]


# ------------------------------------------------------------------------- mutating tools


def _preview_create_scenario(ctx: ToolContext, a: dict[str, Any]) -> str:
    t = tenders.get(ctx.session, ctx.actor, a["tender_id"])
    src = f" copying inputs from scenario {scenarios.get(ctx.session, ctx.actor, a['copy_from_scenario_id']).name}" if a.get("copy_from_scenario_id") else " with default inputs"
    return f"Create scenario '{a['name']}' ({a.get('workflow', 'bid_tariff')}) in tender '{t.name}'{src}."


@tool(
    "create_scenario",
    "Create a new scenario in a tender, optionally copying the inputs of an existing scenario.",
    {"properties": {"tender_id": _s("tender id"), "name": _s("scenario name"), "workflow": _s("bid_tariff | fixed_tariff", enum=["bid_tariff", "fixed_tariff"]), "copy_from_scenario_id": _s("scenario whose current inputs to copy")}, "required": ["tender_id", "name"]},
    permission="scenario.create", mutating=True, preview=_preview_create_scenario,
)
def create_scenario(ctx: ToolContext, a: dict[str, Any]) -> Any:
    inputs = None
    if a.get("copy_from_scenario_id"):
        src = scenarios.get(ctx.session, ctx.actor, a["copy_from_scenario_id"])
        v = scenarios.current_inputs(ctx.session, src)
        inputs = v.inputs if v else None
    sc = scenarios.create(ctx.session, ctx.actor, a["tender_id"], name=a["name"], workflow=a.get("workflow", "bid_tariff"), inputs=inputs)
    return {"scenario_id": sc.id, "name": sc.name, "revision": sc.revision}


def _preview_launch_run(ctx: ToolContext, a: dict[str, Any]) -> str:
    sc = scenarios.get(ctx.session, ctx.actor, a["scenario_id"])
    detail = f" at a fixed tariff of {a['tariff']} INR/kWh ({a.get('dispatch', 'milp')} dispatch)" if a["kind"] == "fixed_tariff" else ""
    return f"Launch a {a['kind']} run on scenario '{sc.name}' (revision {sc.revision}){detail}."


@tool(
    "launch_run",
    "Queue a run on a scenario: bid_tariff (find the lowest tariff meeting the return target) or fixed_tariff (evaluate the investment at a given tariff).",
    {"properties": {"scenario_id": _s("scenario id"), "kind": _s("bid_tariff | fixed_tariff", enum=["bid_tariff", "fixed_tariff"]), "tariff": _n("tariff in INR/kWh for fixed_tariff"), "dispatch": _s("milp | rules", enum=["milp", "rules"])}, "required": ["scenario_id", "kind"]},
    permission="run.launch", mutating=True, preview=_preview_launch_run,
)
def launch_run(ctx: ToolContext, a: dict[str, Any]) -> Any:
    settings: dict[str, Any] = {}
    if a["kind"] == "fixed_tariff":
        if a.get("tariff") is None:
            raise ToolError("invalid_arguments", "fixed_tariff needs a tariff")
        settings = {"tariff": a["tariff"], "dispatch": a.get("dispatch", "milp")}
    run, job = runs.launch(ctx.session, ctx.settings, ctx.actor, a["scenario_id"], kind=a["kind"], solver_settings=settings)
    return {"run_id": run.id, "job_id": job.id, "status": run.status, "kind": run.kind}


def _preview_post_comment(ctx: ToolContext, a: dict[str, Any]) -> str:
    t = tenders.get(ctx.session, ctx.actor, a["tender_id"])
    return f"Post to the chat of tender '{t.name}': \"{a['body'][:120]}\""


@tool("post_comment", "Post a message to a tender's chat on the user's behalf.", {"properties": {"tender_id": _s("tender id"), "body": _s("message text")}, "required": ["tender_id", "body"]}, permission="comment.write", mutating=True, preview=_preview_post_comment)
def post_comment(ctx: ToolContext, a: dict[str, Any]) -> Any:
    c = collaboration.post(ctx.session, ctx.actor, a["tender_id"], body=a["body"], kind="chat")
    return {"comment_id": c.id}


def _set_path(obj: dict[str, Any], path: str, value: Any) -> None:
    parts = path.split(".")
    cur = obj
    for p in parts[:-1]:
        nxt = cur.get(p)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[p] = nxt
        cur = nxt
    cur[parts[-1]] = value


def _preview_set_setting(ctx: ToolContext, a: dict[str, Any]) -> str:
    sc = scenarios.get(ctx.session, ctx.actor, a["scenario_id"])
    return f"Set {a['path']} = {a['value']!r} on scenario '{sc.name}' (expecting revision {a['expected_revision']}, now {sc.revision})."


@tool(
    "set_scenario_setting",
    "Change one input value of a scenario (dotted path under its inputs, e.g. settings.declared_cuf). Saves a new input version; refused if the scenario moved since the stated revision.",
    {"properties": {"scenario_id": _s("scenario id"), "path": _s("dotted path under inputs"), "value": {"description": "number, string or boolean"}, "expected_revision": {"type": "integer", "description": "the scenario revision the user is looking at"}}, "required": ["scenario_id", "path", "value", "expected_revision"]},
    permission="scenario.edit", mutating=True, preview=_preview_set_setting,
)
def set_scenario_setting(ctx: ToolContext, a: dict[str, Any]) -> Any:
    if isinstance(a["value"], dict | list):
        raise ToolError("invalid_arguments", "value must be a number, string or boolean")
    if ".." in a["path"] or a["path"].startswith(".") or len(a["path"]) > 200:
        raise ToolError("invalid_arguments", "bad path")
    sc = scenarios.get(ctx.session, ctx.actor, a["scenario_id"])
    v = scenarios.current_inputs(ctx.session, sc)
    inputs = dict(v.inputs) if v else {}
    _set_path(inputs, a["path"], a["value"])
    nv = scenarios.save_inputs(ctx.session, ctx.actor, sc.id, expected_revision=int(a["expected_revision"]), inputs=inputs, note=f"assistant: set {a['path']}")
    return {"scenario_id": sc.id, "version_no": nv.version_no, "revision": sc.revision, "changed_paths": nv.changed_paths}


def _preview_complete_task(ctx: ToolContext, a: dict[str, Any]) -> str:
    mine = {t.id: t for t in amendments.tasks_for(ctx.session, ctx.actor, tender_id=None, mine=True, status="open")}
    t = mine.get(a["task_id"])
    if t is None:
        raise NotFound("task")
    return f"Mark task '{t.title}' as done."


@tool("complete_task", "Mark one of the user's open review tasks as done.", {"properties": {"task_id": _s("task id")}, "required": ["task_id"]}, permission="requirement.review", mutating=True, preview=_preview_complete_task)
def complete_task(ctx: ToolContext, a: dict[str, Any]) -> Any:
    t = amendments.complete_task(ctx.session, ctx.actor, a["task_id"], status="done")
    return {"task_id": t.id, "status": t.status}


def today() -> date:
    return date.today()
