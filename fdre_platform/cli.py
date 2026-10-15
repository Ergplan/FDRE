"""Management commands: python -m fdre_platform.cli <command>.

  bootstrap --org-slug --org-name --admin-email --admin-name --password   first organisation and administrator
  add-user  --org-slug --email --name --password --role                    a user with a membership
  migrate                                                                 alembic upgrade head
  check-integrations                                                      database, tender_engine, model keys, spreadsheet engine
"""

from __future__ import annotations

import argparse
import subprocess
import sys

from sqlalchemy import select

from fdre_platform.config import get_settings
from fdre_platform.db import make_engine, make_session_factory
from fdre_platform.models import Organization, User
from fdre_platform.services import auth
from fdre_platform.services.context import system_actor


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="fdre_platform.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("bootstrap")
    for flag in ("--org-slug", "--org-name", "--admin-email", "--admin-name", "--password"):
        b.add_argument(flag, required=True)
    u = sub.add_parser("add-user")
    for flag in ("--org-slug", "--email", "--name", "--password", "--role"):
        u.add_argument(flag, required=True)
    sub.add_parser("migrate")
    sub.add_parser("check-integrations")
    args = parser.parse_args(argv)
    settings = get_settings()
    if args.command == "check-integrations":
        return check_integrations(settings)
    if args.command == "migrate":
        return subprocess.call([sys.executable, "-m", "alembic", "upgrade", "head"], env={**__import__("os").environ, "DATABASE_URL": settings.database_url})
    factory = make_session_factory(make_engine(settings.database_url))
    with factory() as session:
        if args.command == "bootstrap":
            if session.scalar(select(Organization).where(Organization.slug == args.org_slug)):
                print("organisation exists", file=sys.stderr)
                return 1
            org = auth.create_organization(session, args.org_slug, args.org_name)
            user = auth.create_user(session, args.admin_email, args.admin_name, args.password)
            auth.add_membership(session, system_actor(org.id, "bootstrap"), user, "administrator")
            session.commit()
            print(f"organisation {org.slug} ({org.id}) with administrator {user.email}")
        elif args.command == "add-user":
            org = session.scalar(select(Organization).where(Organization.slug == args.org_slug))
            if org is None:
                print("no such organisation", file=sys.stderr)
                return 1
            user = session.scalar(select(User).where(User.email == args.email.lower())) or auth.create_user(session, args.email, args.name, args.password)
            auth.add_membership(session, system_actor(org.id, "cli"), user, args.role)
            session.commit()
            print(f"{user.email} is {args.role} in {org.slug}")
    return 0



def check_integrations(settings) -> int:
    """Day-1 external dependency check. Prints one line per dependency; exit 0 even when
    something is missing, so the report can be read, but the missing items are explicit."""
    import os
    import shutil

    import httpx
    from sqlalchemy import text

    rows: list[tuple[str, str, str]] = []
    try:
        with make_engine(settings.database_url).connect() as conn:
            version = conn.execute(text("select version()")).scalar_one()
            head = conn.execute(text("select version_num from alembic_version")).scalar_one_or_none()
        rows.append(("database", "ok", f"{version.split(',')[0]}; migration {head}"))
    except Exception as exc:  # noqa: BLE001
        rows.append(("database", "FAIL", str(exc).splitlines()[0]))
    if settings.tender_engine_url:
        try:
            r = httpx.get(settings.tender_engine_url.rstrip("/") + "/api/v1/health", timeout=10, verify=False)
            rows.append(("tender_engine", "ok" if r.status_code == 200 else "FAIL", f"{settings.tender_engine_url} -> HTTP {r.status_code}"))
        except Exception as exc:  # noqa: BLE001
            rows.append(("tender_engine", "FAIL", f"{settings.tender_engine_url}: {type(exc).__name__}"))
    else:
        rows.append(("tender_engine", "FIXTURES", "TENDER_ENGINE_URL is empty; adapter answers from recorded fixtures"))
    for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
        rows.append((key, "ok" if os.environ.get(key) else "MISSING", "set" if os.environ.get(key) else "not set in the environment"))
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    rows.append(("spreadsheet_engine", "ok" if soffice else "MISSING", soffice or "LibreOffice not found; workbook recalculation check is blocked"))
    try:
        import highspy  # noqa: F401

        rows.append(("milp_solver", "ok", "highspy"))
    except ImportError:
        rows.append(("milp_solver", "MISSING", "pip install highspy"))
    for name, status, detail in rows:
        print(f"{name:20} {status:9} {detail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
