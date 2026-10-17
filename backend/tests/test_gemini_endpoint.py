
"""Integration tests for the Gemini analyst endpoint.

No real Gemini API calls are made.
"""

import json
from types import SimpleNamespace

from conftest import ADMIN
from app import main as main_module


def endpoint(session_id):
    return f"/api/admin/sessions/{session_id}/analyze"


def complete_session(client, session, settings):
    """Store a completed session using the existing database."""
    from app.db import Database

    db = Database(settings.db_path)

    result = {
        "decision": "step-up",
        "risk": 42,
        "coverage": 80,
        "signals": [
            {
                "id": "liveness",
                "risk": 20,
                "provenance": "heuristic",
                "detail": "Test gesture data",
            },
            {
                "id": "pulse",
                "risk": None,
                "provenance": "unavailable",
                "detail": "No pulse evidence",
            },
        ],
    }

    assert db.update_session(
        session["session_id"],
        {
            "status": "completed",
            "decision": "step-up",
            "risk": 42,
            "coverage": 80,
            "result_json": json.dumps(result),
        },
    )

    return result


def fake_report():
    return SimpleNamespace(
        model_dump=lambda: {
            "summary": "Additional verification is recommended.",
            "findings": [],
            "missing_evidence": ["Pulse signal"],
            "recommended_next_steps": [
                "Use a trusted second factor."
            ],
            "confidence": "medium",
            "limitations": "Experimental signals only.",
        }
    )


def test_requires_admin_authentication(client, session):
    url = endpoint(session["session_id"])

    assert client.post(url).status_code == 401

    assert client.post(
        url,
        headers={"Authorization": "Bearer incorrect"},
    ).status_code == 401


def test_rejects_incomplete_session(client, session):
    response = client.post(
        endpoint(session["session_id"]),
        headers=ADMIN,
    )

    assert response.status_code == 409
    assert response.json()["error"] == "session_not_completed"


def test_rejects_unknown_session(client):
    response = client.post(
        endpoint("00000000-0000-4000-8000-000000000000"),
        headers=ADMIN,
    )

    assert response.status_code == 404


def test_completed_session_returns_advisory(
    client,
    session,
    settings,
    monkeypatch,
):
    original = complete_session(client, session, settings)
    captured = []

    def mock_generate(evidence):
        captured.append(evidence)
        return fake_report()

    monkeypatch.setattr(
        main_module,
        "generate_analyst_report",
        mock_generate,
    )

    response = client.post(
        endpoint(session["session_id"]),
        headers=ADMIN,
    )

    assert response.status_code == 200

    body = response.json()

    assert body["advisory_only"] is True
    assert body["policy_decision"] == "step-up"
    assert body["policy_risk"] == 42
    assert body["analyst"]["confidence"] == "medium"

    assert len(captured) == 1

    # Gemini must not receive the session ID or
    # unrestricted signal details.
    serialized = json.dumps(captured[0])

    assert session["session_id"] not in serialized
    assert "Test gesture data" not in serialized
    assert "No pulse evidence" not in serialized

    # The authoritative stored result must not change.
    from app.db import Database

    stored = Database(settings.db_path).get_session(
        session["session_id"]
    )

    assert json.loads(stored["result_json"]) == original


def test_gemini_failure_does_not_change_policy(
    client,
    session,
    settings,
    monkeypatch,
):
    from app.db import Database
    from app.gemini_analyst import GeminiAnalystError

    original = complete_session(client, session, settings)

    def mock_failure(evidence):
        raise GeminiAnalystError("Mock service failure")

    monkeypatch.setattr(
        main_module,
        "generate_analyst_report",
        mock_failure,
    )

    response = client.post(
        endpoint(session["session_id"]),
        headers=ADMIN,
    )

    assert response.status_code == 503
    assert response.json()["error"] == "analyst_unavailable"

    stored = Database(settings.db_path).get_session(
        session["session_id"]
    )

    assert json.loads(stored["result_json"]) == original


# --------------------------------------------------
# Gemini caching and rate-limiting tests
# --------------------------------------------------


def test_gemini_report_is_cached(
    client, session, settings, monkeypatch
):
    """Repeated analysis should reuse the cached report."""

    complete_session(client, session, settings)

    calls = []

    def mock_generate(evidence):
        calls.append(evidence)
        return fake_report()

    monkeypatch.setattr(
        main_module,
        "generate_analyst_report",
        mock_generate,
    )

    url = endpoint(session["session_id"])

    first = client.post(url, headers=ADMIN)
    second = client.post(url, headers=ADMIN)

    assert first.status_code == 200
    assert second.status_code == 200

    assert first.json() == second.json()

    # Only one Gemini generation should occur.
    assert len(calls) == 1


def test_gemini_rate_limit(
    client, settings, monkeypatch
):
    """Six different sessions should exceed the five-call limit."""

    from app.db import Database
    from app.plan import create_plan

    import time
    import uuid

    db = Database(settings.db_path)

    calls = []

    def mock_generate(evidence):
        calls.append(evidence)
        return fake_report()

    monkeypatch.setattr(
        main_module,
        "generate_analyst_report",
        mock_generate,
    )

    statuses = []

    for i in range(6):
        session_id = str(uuid.uuid4())
        now = int(time.time() * 1000)

        db.create_session({
            "id": session_id,
            "created_at": now,
            "expires_at": now + 300000,
            "status": "completed",
            "plan_json": json.dumps(create_plan()),
            "plan_consumed": 1,
            "decision": "step-up",
            "risk": 40,
            "coverage": 80,
            "result_json": json.dumps({
                "decision": "step-up",
                "risk": 40,
                "coverage": 80,
                "signals": [],
            }),
        })

        response = client.post(
            endpoint(session_id),
            headers=ADMIN,
        )

        statuses.append(response.status_code)

    assert statuses == [
        200, 200, 200, 200, 200, 429
    ]

    # Gemini should only be called five times.
    assert len(calls) == 5


def test_gemini_failure_is_not_cached(
    client, session, settings, monkeypatch
):
    """Failed Gemini requests must not be cached."""

    from app.gemini_analyst import GeminiAnalystError

    complete_session(client, session, settings)

    attempts = []

    def mock_generate(evidence):
        attempts.append(1)

        if len(attempts) == 1:
            raise GeminiAnalystError(
                "Temporary Gemini failure"
            )

        return fake_report()

    monkeypatch.setattr(
        main_module,
        "generate_analyst_report",
        mock_generate,
    )

    url = endpoint(session["session_id"])

    first = client.post(url, headers=ADMIN)
    second = client.post(url, headers=ADMIN)

    assert first.status_code == 503
    assert second.status_code == 200

    # The failed request should not prevent retrying.
    assert len(attempts) == 2

# --------------------------------------------------
# Gemini concurrency and cache invalidation tests
# --------------------------------------------------


def test_concurrent_gemini_requests_share_one_generation(
    client, session, settings, monkeypatch
):
    """Two simultaneous requests should call Gemini only once."""

    import asyncio
    import threading
    import time
    import httpx

    complete_session(client, session, settings)

    calls = []
    started = threading.Event()
    release = threading.Event()

    def mock_generate(evidence):
        calls.append(evidence)
        started.set()
        assert release.wait(timeout=5)
        return fake_report()

    monkeypatch.setattr(
        main_module,
        "generate_analyst_report",
        mock_generate,
    )

    async def run_requests():
        transport = httpx.ASGITransport(app=client.app)

        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
        ) as async_client:

            url = endpoint(session["session_id"])

            first = asyncio.create_task(
                async_client.post(url, headers=ADMIN)
            )

            assert await asyncio.to_thread(
                started.wait, 5
            ), "First Gemini request did not start."

            second = asyncio.create_task(
                async_client.post(url, headers=ADMIN)
            )

            await asyncio.sleep(0.05)
            release.set()

            return await asyncio.gather(first, second)

    try:
        first, second = asyncio.run(run_requests())
    finally:
        release.set()

    assert first.status_code == 200
    assert second.status_code == 200

    assert first.json() == second.json()
    assert len(calls) == 1


def test_changed_evidence_invalidates_gemini_cache(
    client, session, settings, monkeypatch
):
    """Changed stored evidence must trigger fresh analysis."""

    from app.db import Database

    original = complete_session(
        client, session, settings
    )

    calls = []

    def mock_generate(evidence):
        calls.append(evidence)
        return fake_report()

    monkeypatch.setattr(
        main_module,
        "generate_analyst_report",
        mock_generate,
    )

    url = endpoint(session["session_id"])

    first = client.post(url, headers=ADMIN)

    assert first.status_code == 200
    assert len(calls) == 1

    # Simulate a changed authoritative stored result.
    # This is a test-only database modification.
    changed = {
        **original,
        "risk": 65,
        "signals": [
            {
                **signal,
                "risk": 65,
            }
            if signal["id"] == "liveness"
            else signal
            for signal in original["signals"]
        ],
    }

    db = Database(settings.db_path)

    assert db.update_session(
        session["session_id"],
        {
            "risk": 65,
            "result_json": json.dumps(changed),
        },
    )

    second = client.post(url, headers=ADMIN)

    assert second.status_code == 200
    assert len(calls) == 2

    assert calls[0]["policy_risk"] == 42
    assert calls[1]["policy_risk"] == 65

    assert second.json()["policy_risk"] == 65
