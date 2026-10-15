"""Adapter for Ergplan/tender_engine (parsing, evidence-linked extraction, versions and
amendments). Built against the routes inspected in that repository on 2026-10-15:

    POST /api/v1/tenders                               {type, agency, external_ref, title}
    POST /api/v1/tenders/{id}/versions   multipart file + kind, issued_on, role, summary_of_change
    GET  /api/v1/tenders/{id}/versions
    GET  /api/v1/tenders/{id}/view                     TenderView: fields[{field_path, value, version_no, evidence[...]}]
    GET  /api/v1/tenders/{id}/review-state             candidates with evidence and validation
    GET  /api/v1/tenders/{id}/amendments               per-version added/changed/restated
    POST /api/v1/tenders/{id}/extract                  202, queues extraction (needs the engine's ANTHROPIC key)
    POST /api/v1/tenders/{id}/summarize                202
    POST /api/v1/approvals                             a reviewer decision

Identity: tender_engine has no user login; inside its deployment a caller names itself with
the X-Reviewer header (our settings.tender_engine_reviewer). Review tokens are per tender and
are not used by the adapter.

Two implementations share one interface: `HttpTenderEngine` for a live instance and
`FixtureTenderEngine`, which answers from recorded JSON under tests/fixtures/tender_engine/
and labels every answer source="fixture". The platform never imports tender_engine code.
"""

from __future__ import annotations

import json
import pathlib
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Protocol

import httpx

FIXTURE_DIR = pathlib.Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "tender_engine"
LOCATED = ("located", "exact", "fuzzy")


class TenderEngineError(Exception):
    pass


@dataclass
class EngineTender:
    id: str
    tender_type: str
    status: str
    current_version_no: int | None
    source: str = "live"


@dataclass
class EngineVersion:
    id: str
    version_no: int
    kind: str
    issued_on: date | None
    document_ids: list[str] = field(default_factory=list)
    source: str = "live"


@dataclass
class Candidate:
    """A requirement candidate in the platform's shape, whatever produced it."""

    field_path: str
    value: Any
    provenance: str = "extracted"  # extracted | inferred | defaulted | user_entered
    confidence: float | None = None
    evidence: dict[str, Any] | None = None  # {document_id, document_version, page, clause, excerpt, bbox}
    extractor: str = "tender_engine"
    unit: str | None = None
    effective_date: date | None = None
    source: str = "live"  # live | fixture | local | user

    def as_dict(self) -> dict[str, Any]:
        d = self.__dict__.copy()
        d["effective_date"] = self.effective_date.isoformat() if self.effective_date else None
        return d


class TenderEngine(Protocol):
    source: str

    def health(self) -> dict[str, Any]: ...
    def create_tender(self, *, tender_type: str, agency: str, title: str, external_ref: str | None) -> EngineTender: ...
    def add_version(
        self, tender_id: str, *, filename: str, data: bytes, kind: str, issued_on: date | None, role: str, summary_of_change: str | None
    ) -> EngineVersion: ...
    def versions(self, tender_id: str) -> list[EngineVersion]: ...
    def view(self, tender_id: str) -> dict[str, Any]: ...
    def review_state(self, tender_id: str, version_no: int | None = None) -> dict[str, Any]: ...
    def amendments(self, tender_id: str) -> dict[str, Any]: ...
    def extract(self, tender_id: str, version_no: int | None = None) -> dict[str, Any]: ...


def _evidence(ev: dict[str, Any] | None, version_no: int | None, document_map: dict[str, str] | None) -> dict[str, Any] | None:
    if not ev:
        return None
    return {
        "document_id": (document_map or {}).get(ev.get("document_id"), ev.get("document_id")),
        "engine_document_id": ev.get("document_id"),
        "document_version": version_no,
        "page": ev.get("page_no"),
        "bbox": ev.get("bbox"),
        "excerpt": ev.get("quote"),
        "clause": None,
        "resolution": ev.get("resolution"),
    }


def _flatten(field_path: str, value_type: str | None, value: Any) -> list[tuple[str, Any]]:
    """A record value becomes dotted paths the catalogue knows."""
    if value_type in ("record", "record_list") and isinstance(value, dict):
        return [(f"{field_path}.{k}", v) for k, v in value.items() if v is not None and not isinstance(v, (list, dict))]
    return [(field_path, value)]


def candidates_from_view(view: dict[str, Any], *, document_map: dict[str, str] | None = None, source: str = "live") -> list[Candidate]:
    """TenderView.fields -> candidates (decided facts with their evidence spans). A decided
    field whose value is None on a later version is a stated removal (the clause was
    deleted) and is passed through as a candidate with value None."""
    out: list[Candidate] = []
    for f in view.get("fields", []):
        if f.get("value") is None and not (f.get("decided") and f.get("evidence")):
            continue
        evidence = _evidence((f.get("evidence") or [None])[0], f.get("version_no"), document_map)
        for path, value in _flatten(f["field_path"], f.get("value_type"), f.get("value")):
            out.append(
                Candidate(
                    field_path=path, value=value, confidence=1.0 if f.get("decided") else None, evidence=evidence, unit=f.get("unit") if path == f["field_path"] else None, source=source, provenance="extracted"
                )
            )
    return out


def candidates_from_review_state(state: dict[str, Any], *, document_map: dict[str, str] | None = None, source: str = "live") -> list[Candidate]:
    """ReviewState.fields -> candidates from each field's best live candidate (undecided
    readings carrying the model's confidence; unlocated evidence makes them inferred)."""
    out: list[Candidate] = []
    for f in state.get("fields", []):
        cand = f.get("candidate")
        if not cand or cand.get("value") is None:
            continue
        evidence = _evidence((cand.get("evidence") or [None])[0], state.get("object_version"), document_map)
        located = bool(evidence and evidence.get("resolution") in LOCATED)
        for path, value in _flatten(f["field_path"], f.get("value_type"), cand.get("value")):
            out.append(
                Candidate(
                    field_path=path, value=value, confidence=cand.get("confidence"), evidence=evidence, unit=f.get("unit") if path == f["field_path"] else None, source=source, provenance="extracted" if located else "inferred"
                )
            )
    return out


class HttpTenderEngine:
    source = "live"

    def __init__(self, base_url: str, reviewer: str, admin_token: str = "", timeout: float = 60.0, verify: bool = False) -> None:
        self.base = base_url.rstrip("/") + "/api/v1"
        headers = {"X-Reviewer": reviewer}
        if admin_token:
            headers["X-Admin-Token"] = admin_token
        self.client = httpx.Client(headers=headers, timeout=timeout, verify=verify)

    def _check(self, r: httpx.Response) -> Any:
        if r.status_code >= 400:
            raise TenderEngineError(f"tender_engine {r.request.method} {r.request.url.path} -> {r.status_code}: {r.text[:300]}")
        return r.json() if r.content else None

    def health(self) -> dict[str, Any]:
        return dict(self._check(self.client.get(f"{self.base}/health")))

    def create_tender(self, *, tender_type: str, agency: str, title: str, external_ref: str | None) -> EngineTender:
        d = self._check(self.client.post(f"{self.base}/tenders", json={"type": tender_type, "agency": agency, "title": title, "external_ref": external_ref}))
        return EngineTender(id=d["id"], tender_type=d["tender_type"], status=d["status"], current_version_no=d.get("current_version_no"))

    def add_version(
        self, tender_id: str, *, filename: str, data: bytes, kind: str, issued_on: date | None, role: str, summary_of_change: str | None
    ) -> EngineVersion:
        form: dict[str, Any] = {"kind": kind, "role": role}
        if issued_on:
            form["issued_on"] = issued_on.isoformat()
        if summary_of_change:
            form["summary_of_change"] = summary_of_change
        d = self._check(self.client.post(f"{self.base}/tenders/{tender_id}/versions", data=form, files={"file": (filename, data, "application/pdf")}))
        return _version(d)

    def versions(self, tender_id: str) -> list[EngineVersion]:
        return [_version(d) for d in self._check(self.client.get(f"{self.base}/tenders/{tender_id}/versions"))]

    def view(self, tender_id: str) -> dict[str, Any]:
        return dict(self._check(self.client.get(f"{self.base}/tenders/{tender_id}/view")))

    def review_state(self, tender_id: str, version_no: int | None = None) -> dict[str, Any]:
        """The tender router wraps core's ReviewState as TenderReviewState {tender_id,
        version_no, version_kind, changed_fields, missing_required, state}; unwrap it."""
        params = {"version_no": version_no} if version_no else {}
        d = dict(self._check(self.client.get(f"{self.base}/tenders/{tender_id}/review-state", params=params)))
        if "state" in d and isinstance(d["state"], dict):
            state = dict(d["state"])
            state.update({"tender_id": d.get("tender_id"), "version_no": d.get("version_no"), "version_kind": d.get("version_kind"), "changed_fields": d.get("changed_fields", []), "missing_required": d.get("missing_required", [])})
            return state
        return d

    def amendments(self, tender_id: str) -> dict[str, Any]:
        return dict(self._check(self.client.get(f"{self.base}/tenders/{tender_id}/amendments")))

    def extract(self, tender_id: str, version_no: int | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"mode": "sync"}
        if version_no:
            body["version_no"] = version_no
        return {"runs": self._check(self.client.post(f"{self.base}/tenders/{tender_id}/extract", json=body))}


def _version(d: dict[str, Any]) -> EngineVersion:
    return EngineVersion(
        id=d["id"],
        version_no=d["version_no"],
        kind=d["kind"],
        issued_on=date.fromisoformat(d["issued_on"]) if d.get("issued_on") else None,
        document_ids=[x["document_id"] for x in d.get("documents", [])],
    )


class FixtureTenderEngine:
    """Answers from recorded fixtures. Every object it returns says source="fixture". The
    fixture is chosen by the external_ref "fixture:<name>" given at creation; its JSON holds
    "view" / "review_state" / "amendments" keyed by the number of versions uploaded so far."""

    source = "fixture"

    def __init__(self, fixture_dir: pathlib.Path = FIXTURE_DIR) -> None:
        self.dir = fixture_dir
        self._tenders: dict[str, dict[str, Any]] = {}
        self._counter = 0

    def _load(self, name: str) -> dict[str, Any]:
        path = self.dir / f"{name}.json"
        if not path.exists():
            raise TenderEngineError(f"no tender_engine fixture named {name}")
        return json.loads(path.read_text())

    def health(self) -> dict[str, Any]:
        return {"status": "ok", "source": "fixture", "fixtures": sorted(p.stem for p in self.dir.glob("*.json"))}

    def create_tender(self, *, tender_type: str, agency: str, title: str, external_ref: str | None) -> EngineTender:
        self._counter += 1
        tid = f"fx{self._counter:030d}"
        name = external_ref.split(":", 1)[1] if external_ref and external_ref.startswith("fixture:") else None
        self._tenders[tid] = {"type": tender_type, "fixture": name, "versions": []}
        return EngineTender(id=tid, tender_type=tender_type, status="ingested", current_version_no=None, source="fixture")

    def add_version(
        self, tender_id: str, *, filename: str, data: bytes, kind: str, issued_on: date | None, role: str, summary_of_change: str | None
    ) -> EngineVersion:
        t = self._tenders.setdefault(tender_id, {"type": "fdre", "fixture": None, "versions": []})
        no = len(t["versions"]) + 1
        v = EngineVersion(id=f"{tender_id}v{no}", version_no=no, kind=kind, issued_on=issued_on, document_ids=[f"{tender_id}d{no}"], source="fixture")
        t["versions"].append(v)
        return v

    def versions(self, tender_id: str) -> list[EngineVersion]:
        return list(self._tenders.get(tender_id, {"versions": []})["versions"])

    def _fixture_for(self, tender_id: str, key: str) -> dict[str, Any]:
        t = self._tenders.get(tender_id) or {"fixture": None, "versions": []}
        name = t["fixture"]
        if not name:
            return {"source": "fixture", "fields": [], "versions": []}
        fx = self._load(name)
        n = len(t["versions"])
        data = fx.get(key, {})
        chosen = data.get(str(n)) if isinstance(data, dict) and str(n) in data else data
        chosen = dict(chosen)
        chosen["source"] = "fixture"
        return chosen

    def view(self, tender_id: str) -> dict[str, Any]:
        return self._fixture_for(tender_id, "view")

    def review_state(self, tender_id: str, version_no: int | None = None) -> dict[str, Any]:
        return self._fixture_for(tender_id, "review_state")

    def amendments(self, tender_id: str) -> dict[str, Any]:
        return self._fixture_for(tender_id, "amendments")

    def extract(self, tender_id: str, version_no: int | None = None) -> dict[str, Any]:
        return {"runs": [], "source": "fixture", "note": "fixture mode: no extraction is run"}


def build_engine(settings: Any) -> TenderEngine:
    if settings.tender_engine_url:
        return HttpTenderEngine(settings.tender_engine_url, settings.tender_engine_reviewer, settings.tender_engine_admin_token)
    return FixtureTenderEngine()
