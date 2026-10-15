"""Service exceptions to HTTP answers."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from fdre_platform.services.auth import AuthError
from fdre_platform.services.context import PermissionDenied
from fdre_platform.services.jobs import DuplicateJob
from fdre_platform.services.tenders import Conflict, NotFound, ValidationFailed


def install(app: FastAPI) -> None:
    @app.exception_handler(NotFound)
    async def _not_found(request: Request, exc: NotFound) -> JSONResponse:
        return JSONResponse(status_code=404, content={"error": "not_found", "message": f"{exc} not found"})

    @app.exception_handler(PermissionDenied)
    async def _forbidden(request: Request, exc: PermissionDenied) -> JSONResponse:
        return JSONResponse(status_code=403, content={"error": "forbidden", "message": str(exc)})

    @app.exception_handler(Conflict)
    async def _conflict(request: Request, exc: Conflict) -> JSONResponse:
        return JSONResponse(status_code=409, content={"error": "conflict", "message": str(exc), "current_revision": exc.current_revision, "conflicts": exc.conflicts})

    @app.exception_handler(ValidationFailed)
    async def _invalid(request: Request, exc: ValidationFailed) -> JSONResponse:
        return JSONResponse(status_code=422, content={"error": "validation_failed", "message": str(exc)})

    @app.exception_handler(AuthError)
    async def _auth(request: Request, exc: AuthError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"error": "auth_error", "message": str(exc)})

    @app.exception_handler(DuplicateJob)
    async def _dup(request: Request, exc: DuplicateJob) -> JSONResponse:
        return JSONResponse(status_code=409, content={"error": "idempotency_conflict", "message": "the idempotency key was used with different content"})
