import base64
import sqlite3
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

ADMIN_TOKEN = "test-admin-token"
ADMIN = {"Authorization": f"Bearer {ADMIN_TOKEN}"}


@pytest.fixture
def settings(tmp_path):
    return Settings(db_path=str(tmp_path / "aegis-test.db"), admin_token=ADMIN_TOKEN,
                    signing_key_b64=base64.b64encode(bytes(range(32))).decode(),
                    allowed_origins=("http://localhost:3000",), frontend_origin="https://frontend.example")


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture
def sql(settings):
    def run(statement, args=()):
        with sqlite3.connect(settings.db_path) as db:
            return db.execute(statement, args).fetchall()
    return run


@pytest.fixture
def session(client):
    """A freshly created session: {session_id, plan, server_now_ms, ...}."""
    response = client.post("/api/sessions", json={"client_now_ms": 1_000_000})
    assert response.status_code == 201
    return response.json()
