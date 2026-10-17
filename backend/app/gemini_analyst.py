
"""Gemini-assisted security analysis for Aegis Presence.

This module generates advisory reports from structured
verification evidence.

Security principles:
- Gemini never makes authentication decisions.
- The deterministic backend policy remains authoritative.
- No raw video, audio, transcripts, or biometric samples are sent.
- Session identifiers are excluded from Gemini requests.
- Generated reports are validated using Pydantic.
"""

from __future__ import annotations

import json
import math
import os
from typing import Any

from google import genai
from google.genai import types
from pydantic import ValidationError

from .analyst_schemas import AnalystReport


# Gemini model verified using the project's API key.
MODEL = os.getenv(
    "GEMINI_MODEL",
    "gemini-3.8-flash",
)


ALLOWED_SIGNALS = {
    "injection",
    "liveness",
    "reflection",
    "pulse",
    "sync",
    "texture",
}

ALLOWED_PROVENANCE = {
    "observed",
    "heuristic",
    "server",
    "simulated",
    "unavailable",
}

ALLOWED_DECISIONS = {
    "approve",
    "step-up",
    "reject",
}


SYSTEM_INSTRUCTION = """
You are the Aegis Presence Security Analyst.

Your responsibility is to analyze structured verification
evidence and generate a security-review report.

You are an advisory assistant, not an authentication system.

Strict rules:

1. Never authenticate, approve, or reject a person.
2. Never override the deterministic policy decision.
3. Analyze only evidence explicitly supplied by the backend.
4. Do not invent measurements, identities, or attack details.
5. Missing evidence must always be treated as unavailable.
6. Missing evidence must never be interpreted as a pass.
7. Never claim that a deepfake or replay attack was proven.
8. Treat rPPG, facial gestures, and audio-visual synchronization
   as experimental and unvalidated security heuristics.
9. Risk scores are not calibrated fraud probabilities.
10. Simulated evidence is not real-world observation.
11. Clearly communicate uncertainty and limitations.
12. Recommend human review or trusted second-factor verification
    when evidence is incomplete or concerning.
13. Never generate findings for signal IDs absent from the input.
14. Never modify the policy decision or risk score.
15. Return only the requested structured JSON report.

The generated report must not be used as proof of identity,
fraud, liveness, or authorization.
"""


class GeminiAnalystError(Exception):
    """Raised when Gemini cannot generate a valid report."""


def valid_risk(value: Any) -> float | None:
    """Accept only finite risk values between 0 and 100."""

    if isinstance(value, bool):
        return None

    if not isinstance(value, (int, float)):
        return None

    if not math.isfinite(value):
        return None

    if not 0 <= value <= 100:
        return None

    return float(value)


def prepare_evidence(
    session_id: str,
    policy_result: dict[str, Any],
) -> dict[str, Any]:
    """Prepare minimal, allowlisted verification evidence.

    The session_id parameter is retained for compatibility
    but is never included in the Gemini request.

    Free-text details, raw media, transcripts, and biometric
    measurements are deliberately excluded.
    """

    # Never send the session identifier to Gemini.
    _ = session_id

    raw_signals = policy_result.get(
        "signals",
        [],
    )

    if not isinstance(raw_signals, list):
        raw_signals = []

    signals: list[dict[str, Any]] = []
    seen_signals: set[str] = set()

    for signal in raw_signals:
        if not isinstance(signal, dict):
            continue

        signal_id = signal.get("id")

        if signal_id not in ALLOWED_SIGNALS:
            continue

        # Ignore duplicate signal IDs.
        if signal_id in seen_signals:
            continue

        seen_signals.add(signal_id)

        risk = valid_risk(
            signal.get("risk")
        )

        provenance = signal.get(
            "provenance"
        )

        if provenance not in ALLOWED_PROVENANCE:
            provenance = "unavailable"

        if provenance == "unavailable":
            risk = None

        if risk is None:
            provenance = "unavailable"

        signals.append({
            "id": signal_id,
            "risk": risk,
            "provenance": provenance,
        })

    decision = policy_result.get(
        "decision"
    )

    if decision not in ALLOWED_DECISIONS:
        raise GeminiAnalystError(
            "Invalid policy decision."
        )

    policy_risk = valid_risk(
        policy_result.get("risk")
    )

    if policy_risk is None:
        raise GeminiAnalystError(
            "Invalid policy risk score."
        )

    coverage = valid_risk(
        policy_result.get("coverage")
    )

    if coverage is None:
        raise GeminiAnalystError(
            "Invalid evidence coverage."
        )

    return {
        "policy_decision": decision,
        "policy_risk": policy_risk,
        "coverage": coverage,
        "signals": signals,
    }


def validate_report_grounding(
    report: AnalystReport,
    evidence: dict[str, Any],
) -> None:
    """Reject findings referencing absent signal IDs.

    This is structural validation, not proof that the
    generated natural-language explanations are factual.
    """

    supplied_ids = {
        signal["id"]
        for signal in evidence.get("signals", [])
        if isinstance(signal, dict)
        and signal.get("id") in ALLOWED_SIGNALS
    }

    for finding in report.findings:
        if finding.signal_id not in supplied_ids:
            raise GeminiAnalystError(
                "Gemini reported a signal absent from the evidence."
            )


def gemini_response_schema() -> dict[str, Any]:
    """Build a Gemini-compatible JSON response schema.

    Pydantic's extra='forbid' setting produces the JSON
    Schema keyword additionalProperties.

    The Gemini endpoint previously rejected that keyword
    when it was sent through response_schema.

    Remove unsupported metadata from the schema supplied
    to Gemini, while keeping strict Pydantic validation
    for the returned report.
    """

    schema = AnalystReport.model_json_schema()

    unsupported_keys = {
        "additionalProperties",
        "title",
        "default",
    }

    def clean(value: Any) -> Any:
        if isinstance(value, dict):
            return {
                key: clean(item)
                for key, item in value.items()
                if key not in unsupported_keys
            }

        if isinstance(value, list):
            return [
                clean(item)
                for item in value
            ]

        return value

    return clean(schema)


def generate_analyst_report(
    evidence: dict[str, Any],
    *,
    client: Any | None = None,
) -> AnalystReport:
    """Generate a structured Gemini security-review report.

    A mock client may be injected for automated testing.
    """

    api_client = client
    owns_client = False

    if api_client is None:
        api_key = os.getenv(
            "GEMINI_API_KEY",
            "",
        ).strip()

        if not api_key:
            raise GeminiAnalystError(
                "Gemini API key is not configured."
            )

        try:
            api_client = genai.Client(
                api_key=api_key,
                http_options=types.HttpOptions(
                    timeout=20000,
                ),
            )

            owns_client = True

        except Exception as exc:
            raise GeminiAnalystError(
                "Gemini client could not be initialized."
            ) from exc

    try:
        serialized_evidence = json.dumps(
            evidence,
            allow_nan=False,
            separators=(",", ":"),
        )

        # Restrict request size.
        if len(serialized_evidence) > 8192:
            raise GeminiAnalystError(
                "Gemini evidence payload is too large."
            )

        response = api_client.models.generate_content(
            model=MODEL,
            contents=serialized_evidence,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTION,
                response_mime_type="application/json",
                response_json_schema=gemini_response_schema(),
                temperature=0,
                max_output_tokens=2048,
            ),
        )

        if not response.text:
            raise GeminiAnalystError(
                "Gemini returned an empty report."
            )

        report = AnalystReport.model_validate_json(
            response.text
        )

        validate_report_grounding(
            report,
            evidence,
        )

        return report

    except GeminiAnalystError:
        raise

    except (ValidationError, ValueError) as exc:
        raise GeminiAnalystError(
            "Gemini returned an invalid structured report."
        ) from exc

    except Exception as exc:
        raise GeminiAnalystError(
            "Gemini analysis is temporarily unavailable."
        ) from exc

    finally:
        if owns_client and api_client is not None:
            api_client.close()
