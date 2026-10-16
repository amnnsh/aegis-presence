from app.timing import RISK_CLEAN, RISK_HARD, RISK_SOFT, check_freshness

PLAN = {"pulse_hold_ms": 12000, "challenges": [
    {"id": "head", "kind": "head_sequence", "moves": ["left", "up", "right"]},
    {"id": "blink", "kind": "cued_blink", "cue_offsets_ms": [2000, 4500, 7000]},
    {"id": "digits", "kind": "digits", "digits": "0427"},
]}
CREATED, OFFSET = 1_000_000, 500  # server clock is 500 ms ahead of the client


def event(challenge_id, kind, at, **payload):
    return {"challenge_id": challenge_id, "type": kind, "client_ts_ms": CREATED - OFFSET + at, "payload": payload}


def honest(head=(420, 610, 380), blink=(300, 520, 450)):
    events, at = [event("head", "challenge_start", 1000)], 1000
    for index, (move, latency) in enumerate(zip(PLAN["challenges"][0]["moves"], head)):
        at += 3000
        events += [event("head", "cue", at, index=index, move=move), event("head", "response", at + latency, index=index, move=move)]
    events += [event("head", "challenge_end", at + 1000, status="observed"), event("blink", "challenge_start", 12000)]
    for index, (offset, latency) in enumerate(zip(PLAN["challenges"][1]["cue_offsets_ms"], blink)):
        events += [event("blink", "cue", 12000 + offset, index=index), event("blink", "response", 12000 + offset + latency, index=index)]
    return events + [event("digits", "challenge_start", 21000), event("digits", "challenge_end", 25000, status="partial")]


def check(events, now=CREATED + 30000, offset=OFFSET):
    return check_freshness(PLAN, events, CREATED, now, offset)


def test_clean_session_is_low_risk_and_honest_about_scope():
    signal = check(honest())
    assert (signal["id"], signal["risk"], signal["provenance"], signal["flags"]) == ("freshness", RISK_CLEAN, "server", [])
    assert "does not authenticate the camera" in signal["detail"]


def test_anticipatory_response_is_a_hard_flag():
    signal = check(honest(blink=(300, 90, 450)))
    assert signal["risk"] == RISK_HARD and any("anticipatory" in flag for flag in signal["flags"])


def test_machine_regular_timing_is_a_hard_flag():
    signal = check(honest(head=(400, 405, 398), blink=(402, 399, 401)))
    assert signal["risk"] == RISK_HARD and any("machine-regular" in flag for flag in signal["flags"])


def test_two_regular_latencies_are_not_enough_to_flag():
    events = [e for e in honest(blink=(400, 402, 401)) if e["challenge_id"] != "head"][:5]
    assert not any("machine-regular" in flag for flag in check(events)["flags"])


def test_slow_response_is_one_soft_flag():
    signal = check(honest(head=(420, 2900, 380)))
    assert signal["risk"] == RISK_SOFT and signal["flags"] == ["a cued response fell outside the 150-2500 ms window"]


def test_head_moves_out_of_plan_order_is_a_hard_flag():
    events = honest()
    responses = [e for e in events if e["challenge_id"] == "head" and e["type"] == "response"]
    responses[0]["payload"], responses[1]["payload"] = responses[1]["payload"], responses[0]["payload"]
    signal = check(events)
    assert signal["risk"] == RISK_HARD and "head moves did not arrive in plan order" in signal["flags"]


def test_wrong_head_move_is_a_hard_flag():
    events = honest()
    next(e for e in events if e["type"] == "response")["payload"]["move"] = "down"
    assert "head moves did not arrive in plan order" in check(events)["flags"]


def test_challenges_out_of_plan_order_is_a_hard_flag():
    events = [event("blink", "challenge_start", 1000), event("head", "challenge_start", 5000)]
    assert "challenges started out of plan order" in check(events)["flags"]


def test_events_before_creation_or_after_now_are_hard_flags():
    stale = honest() + [event("digits", "challenge_end", -60000, status="observed")]
    assert check(stale)["risk"] == RISK_HARD
    future = check(honest(), now=CREATED + 5000)
    assert future["risk"] == RISK_HARD and any("outside this session's window" in flag for flag in future["flags"])


def test_missing_evidence_is_soft_never_clean():
    assert check([])["risk"] == RISK_SOFT
    only_lifecycle = [e for e in honest() if e["type"] in ("challenge_start", "challenge_end")]
    assert check(only_lifecycle)["risk"] == RISK_SOFT
    assert check(honest(), offset=None)["risk"] == RISK_SOFT
