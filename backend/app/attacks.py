"""Server-side attack-indicator fusion. Values originate in the browser; this is not attestation."""

from __future__ import annotations

from copy import deepcopy

INDICATORS = {
    "screen_replay": {
        "challenge_failure": "strong",
        "light_mismatch": "strong",
    },
    "virtual_camera": {
        "feed_loop": "strong",
        "no_sensor_response": "strong",
        "frozen_background": "strong",
        "single_native_mode": "supporting",
        "virtual_label": "supporting",
        "perfect_cadence": "supporting",
        "repeated_frames": "supporting",
        "light_response": "supporting",
    },
}


def fuse_attack_checks(reported: list[dict]) -> list[dict]:
    """Ignore client verdicts and kinds; recompute from allowlisted indicator states."""
    by_check = {item.get("id"): item for item in reported if item.get("id") in INDICATORS}
    checks = []
    for check_id, allowed in INDICATORS.items():
        raw = by_check.get(check_id, {})
        by_indicator = {item.get("id"): item for item in raw.get("indicators", []) if item.get("id") in allowed}
        indicators = []
        for indicator_id, kind in allowed.items():
            state = by_indicator.get(indicator_id, {})
            ran = state.get("ran") is True
            fired = ran and state.get("fired") is True
            indicators.append({"id": indicator_id, "kind": kind, "ran": ran, "fired": fired,
                               "detail": "Browser-reported local measurement; legitimate camera software may trigger it."})
        strong = sum(x["fired"] for x in indicators if x["kind"] == "strong")
        supporting = sum(x["fired"] for x in indicators if x["kind"] == "supporting")
        verdict = "likely" if strong >= 2 else "suspected" if strong >= 1 or supporting >= 2 else "not_enough_evidence"
        checks.append({"id": check_id, "verdict": verdict, "indicators": indicators})
    return checks


def apply_attack_policy(result: dict, checks: list[dict]) -> dict:
    out = deepcopy(result)
    out["attack_checks"] = checks
    if out["mode"] != "live":
        return out
    likely = next((check for check in checks if check["verdict"] == "likely"), None)
    suspected = next((check for check in checks if check["verdict"] == "suspected"), None)
    if likely:
        out["decision"] = "reject"
        title = "Virtual camera" if likely["id"] == "virtual_camera" else "Screen replay"
        out["reasons"].append(f"{title}: multiple strong local indicators were observed. These are not hardware attestation or proof of fraud.")
        out["explanation"] = "Multiple local attack indicators were observed. Stop this attempt and use a trusted alternative; this is not proof of fraud."
    elif suspected and out["decision"] == "approve":
        out["decision"] = "step-up"
        out["reasons"].append("An attack check needs review before this session can continue.")
    return out
