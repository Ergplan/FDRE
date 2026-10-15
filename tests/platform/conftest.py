"""Platform tests run against a real PostgreSQL database (TEST_DATABASE_URL, default
fdre_test on localhost). The schema is built by the Alembic migrations, downgraded and
upgraded once per session so the migration round trip is itself under test."""

from __future__ import annotations

import os
import pathlib
import subprocess
import sys
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fdre_platform.api.app import create_app  # noqa: E402
from fdre_platform.config import Settings  # noqa: E402
from fdre_platform.db import make_engine, make_session_factory  # noqa: E402
from fdre_platform.models import Base  # noqa: E402
from fdre_platform.services import auth  # noqa: E402
from fdre_platform.services.context import system_actor  # noqa: E402
from fdre_platform.storage import LocalStorage  # noqa: E402
from fdre_platform.worker.main import Worker  # noqa: E402

TEST_DB = os.environ.get("TEST_DATABASE_URL", "postgresql+psycopg://fdre:fdre@127.0.0.1:5432/fdre_test")


def _alembic(*args: str) -> None:
    env = {**os.environ, "DATABASE_URL": TEST_DB}
    subprocess.run([sys.executable, "-m", "alembic", *args], cwd=ROOT, env=env, check=True, capture_output=True)


@pytest.fixture(scope="session")
def migrated_db() -> str:
    _alembic("downgrade", "base")
    _alembic("upgrade", "head")
    _alembic("check")
    return TEST_DB


@pytest.fixture(scope="session")
def settings(migrated_db: str, tmp_path_factory: pytest.TempPathFactory) -> Settings:
    return Settings(database_url=migrated_db, data_dir=tmp_path_factory.mktemp("data"), session_ttl_hours=1, worker_poll_seconds=0.05, job_lease_seconds=30)


@pytest.fixture(scope="session")
def engine(settings: Settings):
    return make_engine(settings.database_url)


@pytest.fixture(autouse=True)
def clean_tables(engine) -> Iterator[None]:
    yield
    tables = ", ".join(f'"{t}"' for t in Base.metadata.tables)
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {tables} CASCADE"))  # TRUNCATE fires no row triggers


@pytest.fixture
def session_factory(engine):
    return make_session_factory(engine)


@pytest.fixture
def app(settings: Settings):
    return create_app(settings, mount_legacy=False)


@pytest.fixture
def client(app) -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


@pytest.fixture
def worker(settings: Settings, session_factory) -> Worker:
    return Worker(settings, session_factory, LocalStorage(settings.data_dir), worker_id="test-worker")


class Org:
    def __init__(self, id: str, slug: str) -> None:
        self.id, self.slug = id, slug
        self.users: dict[str, str] = {}


@pytest.fixture
def seed(session_factory):
    """Two organisations. acme: admin, bidder (bid_manager), eng (engineer), fin (finance_reviewer),
    viewer. other: admin2. Password for everyone: 'correct-horse'."""

    with session_factory() as s:
        acme = auth.create_organization(s, "acme", "Acme Renewables")
        other = auth.create_organization(s, "other", "Other Power")
        orgs = {"acme": Org(acme.id, "acme"), "other": Org(other.id, "other")}
        for org, slug, email, role in (
            (acme, "acme", "admin@acme.test", "administrator"),
            (acme, "acme", "bidder@acme.test", "bid_manager"),
            (acme, "acme", "eng@acme.test", "engineer"),
            (acme, "acme", "fin@acme.test", "finance_reviewer"),
            (acme, "acme", "viewer@acme.test", "viewer"),
            (other, "other", "admin2@other.test", "administrator"),
        ):
            user = auth.create_user(s, email, email.split("@")[0], "correct-horse")
            auth.add_membership(s, system_actor(org.id, "seed"), user, role)
            orgs[slug].users[email.split("@")[0]] = user.id
        s.commit()
    return orgs


def login(client: TestClient, email: str, password: str = "correct-horse") -> dict[str, str]:
    r = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture
def as_user(client: TestClient):
    return lambda email: login(client, email)
