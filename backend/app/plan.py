"""Per-session challenge plan. Uses the secrets module so a plan cannot be predicted."""
from __future__ import annotations

import secrets

MOVES = ("left", "right", "up", "down")
PULSE_HOLD_MS = 12000
CUE_GAP_MIN_MS = 1500
CUE_GAP_MAX_MS = 4000


def _challenge_id() -> str:
    return "c_" + secrets.token_hex(4)


def _moves(count: int = 3) -> list[str]:
    moves: list[str] = []
    for _ in range(count):
        moves.append(secrets.choice([m for m in MOVES if not moves or m != moves[-1]]))
    return moves


def _cue_offsets(count: int = 3) -> list[int]:
    offsets: list[int] = []
    previous = 0
    for _ in range(count):
        previous += CUE_GAP_MIN_MS + secrets.randbelow(CUE_GAP_MAX_MS - CUE_GAP_MIN_MS + 1)
        offsets.append(previous)
    return offsets


def create_plan() -> dict:
    challenges = [
        {"id": _challenge_id(), "kind": "head_sequence", "moves": _moves()},
        {"id": _challenge_id(), "kind": "cued_blink", "cue_offsets_ms": _cue_offsets()},
        {"id": _challenge_id(), "kind": "digits", "digits": "".join(str(secrets.randbelow(10)) for _ in range(4))},
    ]
    secrets.SystemRandom().shuffle(challenges)
    return {"challenges": challenges, "pulse_hold_ms": PULSE_HOLD_MS}
