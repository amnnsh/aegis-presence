"""Freshness checks over client-reported events.

These checks test whether reported event timing is consistent with the plan issued for THIS
session. They do not see the camera and cannot authenticate it: a client that fabricates
plausible timestamps passes. Treat the result as a veto input, never as proof of presence.
"""
from __future__ import annotations

import statistics

from .policy import FRESHNESS

EVENT_TYPES = (
    "challenge_start",
    "cue",
    "response",
    "challenge_end",
    "pulse_result",
)
LATENCY_MIN_MS = 150
LATENCY_MAX_MS = 2500
ANTICIPATORY_MS = 120
REGULAR_STDDEV_MS = 15
REGULAR_MIN_SAMPLES = 3
CLOCK_TOLERANCE_MS = 2000  # network delay is folded into clock_offset_ms

RISK_CLEAN, RISK_SOFT, RISK_HARD = 10, 50, 85
SCOPE_NOTE = ("This checks the consistency and freshness of client-reported events only; "
              "it does not authenticate the camera or the person.")


def _index(event: dict):
    value = event["payload"].get("index")
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def check_freshness(plan: dict, events: list[dict], created_ms: int, now_ms: int, clock_offset_ms: int | None) -> dict:
    """events: [{challenge_id, type, client_ts_ms, payload}]. Returns the server "freshness" signal."""
    hard: list[str] = []
    soft: list[str] = []
    events = sorted(events, key=lambda e: e["client_ts_ms"])

    if not events:
        soft.append("no events were reported, so nothing could be checked")
    elif clock_offset_ms is None:
        soft.append("clock offset unknown; session-window check skipped")
    else:
        outside = sum(1 for e in events
                      if not created_ms - CLOCK_TOLERANCE_MS <= e["client_ts_ms"] + clock_offset_ms <= now_ms + CLOCK_TOLERANCE_MS)
        if outside:
            hard.append(f"{outside} event time(s) fall outside this session's window")

    plan_order = [c["id"] for c in plan["challenges"]]
    started: list[str] = []
    for e in events:
        if e["type"] == "challenge_start" and e["challenge_id"] not in started:
            started.append(e["challenge_id"])
    if started != plan_order[:len(started)]:
        hard.append("challenges started out of plan order")

    latencies: list[int] = []
    for challenge in plan["challenges"]:
        mine = [e for e in events if e["challenge_id"] == challenge["id"]]
        cues: dict[int, int] = {}
        for e in mine:
            if e["type"] == "cue" and _index(e) is not None:
                cues.setdefault(_index(e), e["client_ts_ms"])
        responses = [e for e in mine if e["type"] == "response"]
        seen: set[int] = set()
        for e in responses:
            index = _index(e)
            if index is None or index not in cues:
                soft.append("a response had no matching cue")
                continue
            if index in seen:
                continue
            seen.add(index)
            latencies.append(e["client_ts_ms"] - cues[index])
        if challenge["kind"] == "head_sequence":
            moves = challenge["moves"]
            for position, e in enumerate(responses):
                if position >= len(moves) or _index(e) != position or e["payload"].get("move") != moves[position]:
                    hard.append("head moves did not arrive in plan order")
                    break

    if any(latency < ANTICIPATORY_MS for latency in latencies):
        hard.append("anticipatory response (under 120 ms after its cue)")
    if any(ANTICIPATORY_MS <= latency < LATENCY_MIN_MS or latency > LATENCY_MAX_MS for latency in latencies):
        soft.append("a cued response fell outside the 150-2500 ms window")
    if len(latencies) >= REGULAR_MIN_SAMPLES and statistics.pstdev(latencies) < REGULAR_STDDEV_MS:
        hard.append("machine-regular timing (latency spread under 15 ms)")
    if events and not latencies:
        soft.append("no cue/response pairs were reported, so latency checks did not run")

    flags = list(dict.fromkeys(hard + soft))
    if hard:
        risk, summary = RISK_HARD, "Flagged: " + "; ".join(flags) + "."
    elif soft:
        risk, summary = RISK_SOFT, "Flagged (soft): " + "; ".join(flags) + "."
    else:
        risk = RISK_CLEAN
        summary = (f"Clean: {len(latencies)} cued response(s) between {min(latencies)} and {max(latencies)} ms, "
                   "in plan order and inside the session window.")
    return {"id": FRESHNESS, "risk": risk, "provenance": "server", "detail": f"{summary} {SCOPE_NOTE}",
            "flags": flags}
