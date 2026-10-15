"""The platform application: /api/v1 (identity, tenancy, scenarios, runs, jobs, audit)
with the existing workspace API mounted unchanged underneath.

    uvicorn fdre_platform.api.app:app --port 8000
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import Response

from fdre_platform.config import Settings, get_settings
from fdre_platform.db import make_engine, make_session_factory
from fdre_platform.storage import LocalStorage

from . import errors
from fdre_platform.integrations.tender_engine import build_engine

from .routes import auth, health, notifications, orgs, runs, scenarios, tender_intel, tenders

log = logging.getLogger("fdre_platform.api")


def create_app(settings: Settings | None = None, *, mount_legacy: bool = True) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(title="FDRE Enterprise Platform", version="0.1.0", docs_url="/api/v1/docs", openapi_url="/api/v1/openapi.json")
    app.state.settings = settings
    engine = make_engine(settings.database_url)
    app.state.engine = engine
    app.state.session_factory = make_session_factory(engine)
    app.state.storage = LocalStorage(settings.data_dir)
    app.state.tender_engine = build_engine(settings)

    @app.middleware("http")
    async def request_ids(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        request.state.request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        response = await call_next(request)
        response.headers["X-Request-Id"] = request.state.request_id
        return response

    errors.install(app)
    for router in (health.router, auth.router, orgs.router, tenders.router, scenarios.router, runs.router, notifications.router, tender_intel.router):
        app.include_router(router, prefix="/api/v1")

    if mount_legacy:
        try:
            from react_demo.backend.api import app as legacy_app

            app.mount("/", legacy_app)
        except Exception:  # noqa: BLE001 - the platform API must come up even if the legacy wrapper cannot
            log.exception("legacy workspace API could not be mounted")
    return app


app = create_app()
