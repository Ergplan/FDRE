"""Tender intelligence endpoints (package tender_intel), under /api/bid/tender and, for
Round-the-Clock users, the same handlers under /api/rtc/tender.

GET  .../status                -> whether a model is configured, the default mode, the types
GET  .../catalog?tender_type=  -> the compiled sections and fields of a tender type
POST .../read[?sync=1]         -> start a read (202 with a job id) or, with sync=1, the result
GET  .../read/{job_id}         -> the job: status, progress, error, result
"""

from __future__ import annotations

import base64
import binascii
import pathlib
import re
import sys
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tender_intel import TENDER_TYPES, catalog, llm_available, read_tender  # noqa: E402
from tender_intel.llm import provider  # noqa: E402
from tender_intel import jobs  # noqa: E402
from tender_intel.extract import MODES, require_llm, resolve_mode  # noqa: E402
from tender_intel.pages import UnreadableDocument, check_readable  # noqa: E402

MAX_UPLOAD_BYTES = 60 * 1024 * 1024
PREFIXES = ("/api/bid/tender", "/api/rtc/tender")

router = APIRouter(tags=["tender intelligence"])


class TenderIntelFile(BaseModel):
    name: str
    content_base64: str


class TenderIntelReadRequest(BaseModel):
    file: TenderIntelFile
    tender_type: str = "auto"
    mode: str = "auto"


def status() -> dict[str, Any]:
    available = llm_available()
    return {
        "llm_available": available,
        "provider": provider() if available else None,
        "default_mode": "llm" if available else "rules",
        "require_llm": require_llm(),
        "types": list(TENDER_TYPES),
    }


def tender_catalog(tender_type: str = Query("fdre")) -> dict[str, Any]:
    if tender_type not in TENDER_TYPES:
        raise HTTPException(status_code=422, detail=f"Unknown tender type {tender_type!r}; one of {list(TENDER_TYPES)}.")
    return catalog(tender_type)


def _decode(content: str) -> bytes:
    text = content.strip()
    if text.startswith("data:") and "," in text:
        text = text.split(",", 1)[1]
    text = re.sub(r"\s+", "", text)
    try:
        payload = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail="The file could not be decoded (expected base64).") from exc
    if not payload:
        raise HTTPException(status_code=400, detail="The file is empty.")
    return payload


def read(req: TenderIntelReadRequest, response: Response, sync: int = Query(0)) -> dict[str, Any]:
    if len(req.file.content_base64) > MAX_UPLOAD_BYTES * 4 // 3 + 16:
        raise HTTPException(status_code=413, detail="The file is larger than 60 MB.")
    payload = _decode(req.file.content_base64)
    if len(payload) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="The file is larger than 60 MB.")
    if req.tender_type != "auto" and req.tender_type not in TENDER_TYPES:
        raise HTTPException(status_code=422, detail=f"Unknown tender type {req.tender_type!r}; one of auto, {', '.join(TENDER_TYPES)}.")
    if req.mode not in MODES:
        raise HTTPException(status_code=422, detail=f"Unknown mode {req.mode!r}; one of {', '.join(MODES)}.")
    available = llm_available()
    if req.mode == "llm" and not available:
        raise HTTPException(status_code=400, detail="mode=llm needs a model key (OPENAI_API_KEY or ANTHROPIC_API_KEY) on the engine; use mode=rules or auto.")
    try:
        check_readable(req.file.name, payload)
    except UnreadableDocument as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        resolved = resolve_mode(req.file.name, payload, req.mode, available)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if sync:
        try:
            return read_tender(req.file.name, payload, tender_type=req.tender_type, mode=req.mode)
        except (UnreadableDocument, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:  # the model reading is required and could not run
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except LookupError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    job_id = jobs.start(req.file.name, payload, tender_type=req.tender_type, mode=req.mode)
    response.status_code = 202
    return {"job_id": job_id, "status": "queued", "mode": resolved}


def read_job(job_id: str) -> dict[str, Any]:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job.")
    return job


for _prefix in PREFIXES:
    router.add_api_route(f"{_prefix}/status", status, methods=["GET"])
    router.add_api_route(f"{_prefix}/catalog", tender_catalog, methods=["GET"])
    router.add_api_route(f"{_prefix}/read", read, methods=["POST"], status_code=200)
    router.add_api_route(f"{_prefix}/read/{{job_id}}", read_job, methods=["GET"])
