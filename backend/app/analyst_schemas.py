
"""Structured schemas for Gemini-assisted security reviews.

Gemini generates advisory explanations only.
The deterministic risk engine remains authoritative.
"""

from typing import Literal

from pydantic import BaseModel, Field, ConfigDict


class EvidenceFinding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    signal_id: Literal[
        "injection",
        "liveness",
        "reflection",
        "pulse",
        "sync",
        "freshness",
    ]

    observation: str = Field(
        min_length=1,
        max_length=500,
        description="Evidence-grounded observation about the signal.",
    )

    concern: Literal[
        "low",
        "medium",
        "high",
        "unavailable",
    ]

    explanation: str = Field(
        min_length=1,
        max_length=500,
        description="Why the observation matters and its limitations.",
    )


class AnalystReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str = Field(
        min_length=1,
        max_length=1000,
        description="Concise summary grounded in supplied verification evidence.",
    )

    findings: list[EvidenceFinding] = Field(
        default_factory=list,
        max_length=6,
    )

    missing_evidence: list[str] = Field(
        default_factory=list,
        max_length=6,
    )

    recommended_next_steps: list[str] = Field(
        default_factory=list,
        max_length=5,
    )

    confidence: Literal[
        "low",
        "medium",
        "high",
    ] = Field(
        description="Confidence in the completeness of the review, not identity.",
    )

    limitations: str = Field(
        min_length=1,
        max_length=1000,
    )


class AnalystResponse(BaseModel):
    """Backend response combining policy outcome and advisory report."""

    session_id: str
    policy_decision: Literal[
        "approve",
        "step-up",
        "reject",
    ]
    policy_risk: float = Field(ge=0, le=100)
    analyst: AnalystReport
    advisory_only: Literal[True] = True
