from app.attacks import apply_attack_policy, fuse_attack_checks


def test_server_recomputes_virtual_camera_verdict_from_allowed_indicators():
    reported = [{"id": "virtual_camera", "verdict": "not_enough_evidence", "indicators": [
        {"id": "feed_loop", "ran": True, "fired": True, "kind": "supporting"},
        {"id": "frozen_background", "ran": True, "fired": True, "kind": "supporting"},
        {"id": "unlisted", "ran": True, "fired": True},
    ]}]
    checks = fuse_attack_checks(reported)
    virtual = next(c for c in checks if c["id"] == "virtual_camera")
    assert virtual["verdict"] == "likely"
    assert [i["id"] for i in virtual["indicators"] if i["fired"]] == ["feed_loop", "frozen_background"]
    assert all(i["kind"] == "strong" for i in virtual["indicators"] if i["fired"])
    assert next(c for c in checks if c["id"] == "screen_replay")["verdict"] == "not_enough_evidence"


def test_missing_or_rejected_measurements_do_not_fire():
    checks = fuse_attack_checks([{"id": "virtual_camera", "indicators": [
        {"id": "no_sensor_response", "ran": False, "fired": True},
    ]}])
    assert next(c for c in checks if c["id"] == "virtual_camera")["verdict"] == "not_enough_evidence"


def test_likely_attack_tightens_live_decision_only():
    checks = fuse_attack_checks([{"id": "virtual_camera", "indicators": [
        {"id": "feed_loop", "ran": True, "fired": True},
        {"id": "frozen_background", "ran": True, "fired": True},
    ]}])
    base = {"mode": "live", "decision": "step-up", "reasons": [], "explanation": "Review"}
    decided = apply_attack_policy(base, checks)
    assert decided["decision"] == "reject"
    assert "Virtual camera" in decided["reasons"][0]
    assert base["decision"] == "step-up"
