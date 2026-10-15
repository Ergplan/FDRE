from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import text

from fdre_platform import __version__
from fdre_platform.api.deps import SessionDep, SettingsDep

router = APIRouter(tags=["health"])


@router.get("/health")
def health(session: SessionDep, settings: SettingsDep) -> dict:
    session.execute(text("select 1"))
    return {"status": "ok", "version": __version__, "database": "ok", "tender_engine": "configured" if settings.tender_engine_url else "fixtures"}
