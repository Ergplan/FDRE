"""File-backed jobs for tender reads, so any engine worker process can answer a poll.

Not from tender_engine (which queues jobs in Postgres): one JSON file per job in
TENDER_INTEL_JOBS_DIR (default /tmp/tender_intel_jobs), written atomically (temporary
file + os.replace). The read itself runs in a daemon thread of the process that started
it. Job files older than 24 hours are deleted when a job starts.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from tender_intel.extract import read_tender

MAX_AGE_SECONDS = 24 * 3600
# A running job whose file has not changed for this long lost its worker (a restart).
STALE_SECONDS = 3600
_JOB_ID = re.compile(r"^[0-9a-f]{32}$")
_lock = threading.Lock()


def jobs_dir() -> Path:
    path = Path(os.environ.get("TENDER_INTEL_JOBS_DIR") or "/tmp/tender_intel_jobs")
    path.mkdir(parents=True, exist_ok=True)
    return path


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _path(job_id: str) -> Path:
    return jobs_dir() / f"{job_id}.json"


def _write(job: dict[str, Any]) -> None:
    job["updated_at"] = _now()
    directory = jobs_dir()
    handle, temporary = tempfile.mkstemp(prefix=".job-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            json.dump(job, out, ensure_ascii=False, default=str)
        os.replace(temporary, _path(job["job_id"]))
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def cleanup(max_age: float = MAX_AGE_SECONDS) -> int:
    """Delete job files (and stray temporary files) older than max_age seconds."""
    removed = 0
    cutoff = time.time() - max_age
    for path in jobs_dir().glob("*"):
        if not (path.suffix in (".json", ".tmp") and path.is_file()):
            continue
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def start(name: str, payload: bytes, tender_type: str = "auto", mode: str = "auto", sdk: Any | None = None) -> str:
    """Queue a read and run it in a daemon thread. Returns the job id (32 hex digits)."""
    cleanup()
    job_id = uuid.uuid4().hex
    job: dict[str, Any] = {
        "job_id": job_id,
        "status": "queued",
        "progress": {"done": 0, "total": 0, "step": "Queued"},
        "error": None,
        "result": None,
        "created_at": _now(),
        "updated_at": _now(),
        "document": {"name": name, "bytes": len(payload)},
        "tender_type": tender_type,
        "mode": mode,
    }
    _write(job)

    def progress(done: int, total: int, step: str) -> None:
        with _lock:
            job["progress"] = {"done": done, "total": total, "step": step}
            _write(job)

    def run() -> None:
        with _lock:
            job["status"] = "running"
            job["progress"] = {"done": 0, "total": 0, "step": "Reading pages"}
            _write(job)
        try:
            result = read_tender(name, payload, tender_type=tender_type, mode=mode, progress=progress, sdk=sdk)
        except Exception as exc:  # noqa: BLE001 - reported to the poller
            with _lock:
                job["status"] = "failed"
                job["error"] = f"{type(exc).__name__}: {exc}"[:1000]
                _write(job)
            return
        with _lock:
            job["status"] = "done"
            job["result"] = result
            total = job["progress"].get("total") or 1
            job["progress"] = {"done": total, "total": total, "step": "Done"}
            _write(job)

    threading.Thread(target=run, name=f"tender-intel-{job_id[:8]}", daemon=True).start()
    return job_id


def get(job_id: str) -> dict[str, Any] | None:
    """The job as stored, or None for an unknown or malformed id."""
    if not isinstance(job_id, str) or not _JOB_ID.match(job_id):
        return None
    path = _path(job_id)
    for _ in range(3):
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
            break
        except FileNotFoundError:
            return None
        except (json.JSONDecodeError, OSError):
            time.sleep(0.05)
    else:
        return None
    if job.get("status") in ("queued", "running"):
        try:
            age = time.time() - path.stat().st_mtime
        except OSError:
            age = 0
        if age > STALE_SECONDS:
            job["status"] = "failed"
            job["error"] = "The job stopped without finishing (the engine may have restarted); start it again."
    return job
