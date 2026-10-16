"""Server-side port of lib/risk.ts. Keep the two files in lockstep; tests/test_policy.py checks parity.

Illustrative policy, NOT a calibrated fraud probability or an authorization boundary.
"""
from __future__ import annotations

import math

POLICY_VERSION = "0.2.0"

# Signal ids live here only: renaming one (e.g. "artifacts" -> "pulse") is a single edit.
INJECTION, LIVENESS, REFLECTION, ARTIFACTS, SYNC = SIGNAL_IDS = ("injection", "liveness", "reflection", "artifacts", "sync")
FRESHNESS = "freshness"

SIGNALS: tuple[dict, ...] = (
    {"id": INJECTION, "title": "Camera integrity", "weight": 20},
    {"id": LIVENESS, "title": "Active liveness", "weight": 30},
    {"id": REFLECTION, "title": "Light response", "weight": 15},
    {"id": ARTIFACTS, "title": "Deepfake artifacts", "weight": 20},
    {"id": SYNC, "title": "Audio-visual sync", "weight": 15},
)
POLICY = {"stepUp": 30, "reject": 65, "unknownRisk": 60, "injectionVeto": 70, "freshnessVeto": 70, "freshnessFlag": 50}
PROVENANCES = ("observed", "heuristic", "server", "simulated", "unavailable")
USABLE_LIVE = ("observed", "heuristic", "server")


def finite_risk(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 100


def _num(value) -> str:
    """Format like a JavaScript template literal: 80.0 -> "80", 29.6 -> "29.6"."""
    return str(int(value)) if float(value).is_integer() else repr(float(value))


def _explanation(decision: str, mode: str) -> str:
    if decision == "approve":
        return "This synthetic normal-user example falls below the demo threshold. It does not establish anyone's identity."
    if decision == "reject":
        return ("Several fixture signals exceed the demo risk threshold; the illustrative policy rejects this scenario." if mode == "simulation"
                else "Multiple local heuristics raised risk. Stop this attempt and use a trusted alternative; this is not proof of fraud.")
    return ("Some evidence is missing or unverified. Use a trusted second factor or a human-assisted check; this prototype performs neither." if mode == "live"
            else "The fixture has ambiguous evidence. The illustrative policy requests an additional verification method.")


def evaluate_risk(input_signals: list[dict], mode: str) -> dict:
    """Live mode excludes ALL simulated scores. Missing/invalid evidence costs a fixed 60, never renormalized."""
    signals: list[dict] = []
    for meta in SIGNALS:
        matches = [s for s in input_signals if s.get("id") == meta["id"]]
        s = matches[0] if len(matches) == 1 else None
        if s is None or not finite_risk(s.get("risk")) or s.get("provenance") == "unavailable":
            detail = (s.get("detail") if s else None) or "No usable evidence; step-up required."
            signals.append({"id": meta["id"], "risk": None, "provenance": "unavailable", "detail": detail})
        else:
            signals.append({"id": meta["id"], "risk": s["risk"], "provenance": s.get("provenance"), "detail": s.get("detail", "")})
    by_id = {s["id"]: s for s in signals}

    contributions: list[dict] = []
    for meta in SIGNALS:
        s = by_id[meta["id"]]
        usable = finite_risk(s["risk"]) and s["provenance"] != "unavailable" and (mode == "simulation" or s["provenance"] in USABLE_LIVE)
        contributions.append({"id": meta["id"], "weight": meta["weight"],
                              "usedRisk": s["risk"] if usable else POLICY["unknownRisk"], "substituted": not usable})

    raw_risk = 0.0
    for item in contributions:
        raw_risk += item["usedRisk"] * item["weight"] / 100
    risk = math.floor(raw_risk + 0.5)  # Math.round
    coverage = sum(c["weight"] for c in contributions if not c["substituted"])
    camera = next(c for c in contributions if c["id"] == INJECTION)
    flagged = [c for c in contributions if not c["substituted"] and c["usedRisk"] >= 70]
    reasons: list[str] = []
    decision = "reject" if raw_risk >= POLICY["reject"] else "step-up" if raw_risk >= POLICY["stepUp"] else "approve"
    if decision == "approve" and camera["usedRisk"] >= POLICY["injectionVeto"]:
        decision = "step-up"
        reasons.append("Camera metadata needs review; a device label alone cannot prove an attack.")
    if coverage < 100:
        reasons.append(f"Only {coverage}/100 of policy weight has usable {'local' if mode == 'live' else 'fixture'} evidence. "
                       "Missing or excluded inputs use risk 60, not zero.")
        if decision == "approve":
            decision = "step-up"
    if mode == "live":
        # Conservative demo guard: a failed gesture, low light, or a missing model is NOT proof of fraud.
        decision = "reject" if raw_risk >= POLICY["reject"] and len(flagged) >= 2 and coverage >= 50 else "step-up"
        reasons.append("Live sessions cannot approve: deepfake detection is not implemented, and the spoken-digit and lip / voice timing checks are unvalidated heuristics.")
        reasons.append("Scores are uncalibrated browser heuristics. This is not identity verification or an access-control decision.")
    else:
        reasons.append("Every input in this attack-lab session is a deterministic, simulated fixture. No attack was executed or detected.")
    titles = {m["id"]: m["title"] for m in SIGNALS}
    concerning = sorted((c for c in contributions if not c["substituted"] and c["usedRisk"] >= 60),
                        key=lambda c: c["usedRisk"] * c["weight"], reverse=True)
    for c in concerning[:2]:
        reasons.append(f"{titles[c['id']]}: {_num(c['usedRisk'])}/100 risk. {by_id[c['id']]['detail']}")
    return {"decision": decision, "risk": risk, "mode": mode, "coverage": coverage,
            "explanation": _explanation(decision, mode), "reasons": reasons, "signals": signals, "contributions": contributions}


def apply_freshness(result: dict, freshness: dict) -> dict:
    """Freshness is a server-side veto, not a weighted input: it can block "approve", never grant it."""
    out = {**result, "reasons": list(result["reasons"])}
    risk = freshness.get("risk")
    vetoed = not finite_risk(risk) or risk >= POLICY["freshnessVeto"]
    if vetoed and out["decision"] == "approve":
        out["decision"] = "step-up"
        out["explanation"] = _explanation("step-up", out["mode"])
        out["reasons"].append("Server freshness veto: reported event timing was not consistent with this session, so approval is blocked.")
    state = "clean" if finite_risk(risk) and risk < POLICY["freshnessFlag"] else "flagged"
    out["reasons"].append(f"Freshness (server-checked): {state}. {freshness.get('detail', '')}")
    return out
