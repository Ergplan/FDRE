"""The background worker: `python -m fdre_platform.worker`. Polls the job table, claims one
job at a time with a lease, heartbeats while working, retries with backoff."""

from __future__ import annotations

import logging
import signal
import time
from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from fdre_platform.config import Settings, get_settings
from fdre_platform.db import make_engine, make_session_factory
from fdre_platform.services import jobs
from fdre_platform.storage import LocalStorage

from . import handlers

log = logging.getLogger("fdre_platform.worker")


class Worker:
    def __init__(self, settings: Settings, session_factory: sessionmaker[Session], storage: LocalStorage, worker_id: str | None = None) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.storage = storage
        self.worker_id = worker_id or jobs.worker_identity()
        self.stopping = False

    def run_once(self) -> bool:
        with self.session_factory() as session:
            job = jobs.claim_next(session, self.worker_id, self.settings.job_lease_seconds)
            if job is None:
                return False
            job_id, kind, payload = job.id, job.kind, dict(job.payload)
        log.info("job %s (%s) started by %s", job_id, kind, self.worker_id)

        def heartbeat(progress: dict[str, Any] | None = None) -> bool:
            with self.session_factory() as hb:
                return jobs.heartbeat(hb, job_id, self.settings.job_lease_seconds, progress)

        try:
            with self.session_factory() as session:
                if kind == "run":
                    handlers.execute_run(session, self.settings, self.storage, payload["run_id"], heartbeat)
                else:
                    raise handlers_unknown(kind)
        except UnknownJob as exc:
            with self.session_factory() as session:
                jobs.fail(session, job_id, str(exc), retryable=False)
            return True
        except Exception as exc:  # noqa: BLE001 - recorded on the job, retried with backoff
            log.exception("job %s failed", job_id)
            with self.session_factory() as session:
                jobs.fail(session, job_id, f"{type(exc).__name__}: {exc}")
            return True
        with self.session_factory() as session:
            job = session.get(type(job), job_id)
            if job is not None and job.cancel_requested:
                jobs.cancel_done(session, job_id)
            else:
                jobs.complete(session, job_id)
        log.info("job %s done", job_id)
        return True

    def loop(self) -> None:
        while not self.stopping:
            if not self.run_once():
                time.sleep(self.settings.worker_poll_seconds)


class UnknownJob(Exception):
    pass


def handlers_unknown(kind: str) -> UnknownJob:
    return UnknownJob(f"no handler for job kind {kind!r}")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = get_settings()
    engine = make_engine(settings.database_url)
    worker = Worker(settings, make_session_factory(engine), LocalStorage(settings.data_dir))

    def stop(*_: Any) -> None:
        worker.stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log.info("worker %s polling %s", worker.worker_id, settings.database_url.split("@")[-1])
    worker.loop()


if __name__ == "__main__":
    main()
