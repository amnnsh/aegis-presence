
"""Tests for the Gemini Security Analyst.

All Gemini API responses are mocked.
No network requests or API keys are required.
"""

import json
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from backend.app.analyst_schemas import AnalystReport
from backend.app.gemini_analyst import (
    GeminiAnalystError,
    generate_analyst_report,
    prepare_evidence,
)


def sample_policy():
    return {
        "decision": "step-up",
        "risk": 42,
        "coverage": 80,
        "signals": [
            {
                "id": "liveness",
                "risk": 20,
                "provenance": "heuristic",
                "detail": "Head movement observed.",
            },
            {
                "id": "pulse",
                "risk": None,
                "provenance": "unavailable",
                "detail": "Pulse measurement unavailable.",
            },
        ],
    }


def sample_report():
    return {
        "summary": (
            "The verification requires additional review "
            "because some evidence is unavailable."
        ),
        "findings": [
            {
                "signal_id": "pulse",
                "observation": "Pulse evidence was unavailable.",
                "concern": "unavailable",
                "explanation": (
                    "No usable pulse measurement was supplied."
                ),
            }
        ],
        "missing_evidence": [
            "Pulse signal"
        ],
        "recommended_next_steps": [
            "Use a trusted second verification factor."
        ],
        "confidence": "medium",
        "limitations": (
            "These are experimental verification heuristics."
        ),
    }


class MockModels:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def generate_content(self, **kwargs):
        self.calls.append(kwargs)

        if self.error:
            raise self.error

        return SimpleNamespace(
            text=json.dumps(self.response)
            if self.response is not None
            else None
        )


class MockClient:
    def __init__(self, response=None, error=None):
        self.models = MockModels(response, error)


def test_prepare_evidence_allowlists_signals():
    policy = sample_policy()

    evidence = prepare_evidence(
        "test-session",
        policy,
    )

    assert evidence["policy_decision"] == "step-up"
    assert evidence["policy_risk"] == 42

    assert len(evidence["signals"]) == 2

    assert all(
        "detail" not in signal
        for signal in evidence["signals"]
    )


def test_unknown_signals_are_excluded():
    policy = sample_policy()

    policy["signals"].append({
        "id": "unknown",
        "risk": 5,
        "provenance": "observed",
        "detail": "Should not be included.",
    })

    evidence = prepare_evidence(
        "test-session",
        policy,
    )

    assert all(
        signal["id"] != "unknown"
        for signal in evidence["signals"]
    )


def test_invalid_risk_is_unavailable():
    policy = sample_policy()

    policy["signals"][0]["risk"] = 200

    evidence = prepare_evidence(
        "test-session",
        policy,
    )

    assert evidence["signals"][0]["risk"] is None


def test_valid_gemini_response():
    client = MockClient(response=sample_report())

    report = generate_analyst_report(
        prepare_evidence(
            "test-session",
            sample_policy(),
        ),
        client=client,
    )

    assert isinstance(report, AnalystReport)
    assert report.confidence == "medium"
    assert report.findings[0].signal_id == "pulse"

    assert len(client.models.calls) == 1


def test_empty_gemini_response():
    client = MockClient(response=None)

    with pytest.raises(
        GeminiAnalystError,
        match="empty report",
    ):
        generate_analyst_report(
            prepare_evidence(
                "test-session",
                sample_policy(),
            ),
            client=client,
        )


def test_invalid_gemini_response():
    client = MockClient(
        response={
            "summary": "Incomplete report"
        }
    )

    with pytest.raises(
        GeminiAnalystError,
        match="invalid structured report",
    ):
        generate_analyst_report(
            prepare_evidence(
                "test-session",
                sample_policy(),
            ),
            client=client,
        )


def test_gemini_api_failure():
    client = MockClient(
        error=RuntimeError("Mock API failure")
    )

    with pytest.raises(
        GeminiAnalystError,
        match="temporarily unavailable",
    ):
        generate_analyst_report(
            prepare_evidence(
                "test-session",
                sample_policy(),
            ),
            client=client,
        )


def test_report_schema_rejects_unknown_fields():
    report = sample_report()
    report["unexpected_field"] = "not allowed"

    with pytest.raises(ValidationError):
        AnalystReport.model_validate(report)


def test_no_raw_biometric_details_sent():
    policy = sample_policy()

    policy["signals"][0]["detail"] = (
        "Private facial measurements and audio transcript"
    )

    evidence = prepare_evidence(
        "test-session",
        policy,
    )

    serialized = json.dumps(evidence)

    assert "Private facial measurements" not in serialized
    assert "audio transcript" not in serialized

def test_session_identifier_not_sent_to_gemini():
    evidence = prepare_evidence(
        "private-session-123",
        sample_policy(),
    )

    serialized = json.dumps(evidence)

    assert "private-session-123" not in serialized
    assert "session_reference" not in evidence