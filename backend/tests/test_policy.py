"""Parity with lib/risk.ts. Fixtures mirror lib/scenarios.ts; expectations mirror tests/risk.test.ts."""
import pytest

from app.policy import SIGNAL_IDS, SIGNALS, apply_freshness, evaluate_risk

# Scores are in SIGNAL_IDS order: injection, liveness, reflection, artifacts, sync.
ATTACK_LAB = [
    ("normal", [8, 5, 9, 7, 5], 7, "approve"),
    ("replay", [35, 94, 88, 62, 82], 73, "reject"),
    ("virtual", [82, 12, 24, 24, 16], 31, "step-up"),
    ("deepfake", [24, 62, 70, 95, 93], 67, "reject"),
]


def rows(scores, provenance="simulated"):
    return [{"id": signal_id, "risk": score, "provenance": provenance, "detail": "fixture"}
            for signal_id, score in zip(SIGNAL_IDS, scores)]


def heuristic(score):
    return rows([score] * 5, "heuristic")


def test_weights_sum_to_100():
    assert sum(s["weight"] for s in SIGNALS) == 100
    assert tuple(s["id"] for s in SIGNALS) == SIGNAL_IDS


@pytest.mark.parametrize("name,scores,risk,decision", ATTACK_LAB)
def test_attack_lab_fixtures_match_typescript(name, scores, risk, decision):
    result = evaluate_risk(rows(scores), "simulation")
    assert (result["risk"], result["decision"]) == (risk, decision)
    assert result["coverage"] == 100
    assert result["reasons"][-1 if decision == "approve" else 0].startswith(("Every input", "Camera metadata"))


def test_virtual_fixture_reasons_match_typescript_text():
    result = evaluate_risk(rows([82, 12, 24, 24, 16]), "simulation")
    assert result["reasons"] == [
        "Every input in this attack-lab session is a deterministic, simulated fixture. No attack was executed or detected.",
        "Camera integrity: 82/100 risk. fixture",
    ]


def test_empty_and_simulated_live_sessions_never_approve():
    for signals in ([], rows([8, 5, 9, 7, 5])):
        result = evaluate_risk(signals, "live")
        assert (result["risk"], result["coverage"], result["decision"]) == (60, 0, "step-up")
    assert evaluate_risk(heuristic(0), "live")["decision"] == "step-up"


def test_invalid_missing_duplicate_and_non_finite_scores_cost_60():
    signals = heuristic(0)
    signals[0]["risk"], signals[1]["risk"], signals[2]["risk"], signals[3]["risk"] = float("nan"), -1, 101, float("inf")
    signals.append(dict(signals[4]))
    result = evaluate_risk(signals, "live")
    assert (result["risk"], result["coverage"], result["decision"]) == (60, 0, "step-up")


def test_no_renormalization_of_missing_weight():
    result = evaluate_risk([s for s in heuristic(0) if s["id"] != SIGNAL_IDS[1]], "simulation")
    assert (result["risk"], result["coverage"], result["decision"]) == (18, 70, "step-up")


def test_thresholds_use_the_unrounded_score():
    assert [evaluate_risk(heuristic(score), "simulation")["decision"] for score in (29.6, 30, 64.9, 65)] == \
        ["approve", "step-up", "step-up", "reject"]
    assert evaluate_risk(heuristic(29.6), "simulation")["risk"] == 30


def test_virtual_label_vetoes_approval_but_cannot_reject():
    signals = heuristic(0)
    signals[0]["risk"] = 82
    assert evaluate_risk(signals, "simulation")["decision"] == "step-up"
    assert evaluate_risk(signals, "live")["decision"] == "step-up"


def test_live_reject_and_server_provenance_is_usable_live():
    assert evaluate_risk(heuristic(80), "live")["decision"] == "reject"
    assert evaluate_risk(rows([80] * 5, "server"), "live")["coverage"] == 100


def test_inputs_are_not_mutated():
    signals = heuristic(12)
    before = [dict(s) for s in signals]
    evaluate_risk(signals, "live")
    assert signals == before


def test_freshness_is_a_veto_not_a_weight():
    clean = evaluate_risk(rows([8, 5, 9, 7, 5]), "simulation")
    kept = apply_freshness(clean, {"id": "freshness", "risk": 10, "provenance": "server", "detail": "ok"})
    assert (kept["decision"], kept["risk"]) == ("approve", 7)
    assert kept["reasons"][-1].startswith("Freshness (server-checked): clean")
    for risk in (70, 85, None):
        vetoed = apply_freshness(clean, {"id": "freshness", "risk": risk, "provenance": "server", "detail": "bad"})
        assert (vetoed["decision"], vetoed["risk"]) == ("step-up", 7)
        assert any("veto" in reason for reason in vetoed["reasons"])
    soft = apply_freshness(clean, {"id": "freshness", "risk": 50, "provenance": "server", "detail": "soft"})
    assert soft["decision"] == "approve" and "flagged" in soft["reasons"][-1]
    assert clean["decision"] == "approve" and len(clean["reasons"]) == 1
