import base64
import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi.testclient import TestClient

from app.main import Broadcast, RateLimiter, create_app, ua_family
from app.plan import MOVES, create_plan
from app.policy import POLICY_VERSION, SIGNAL_IDS
from conftest import ADMIN

SIGNALS = [{"id": signal_id, "risk": 12, "provenance": "heuristic", "detail": "test input"} for signal_id in SIGNAL_IDS]


def report(client, created, events):
    return client.post(f"/api/sessions/{created['session_id']}/events", json={"events": events})


def cued_events(created, latencies=(310, 540, 420)):
    """Honest-looking cue/response pairs on the blink challenge, stamped just after session creation.

    The plan order is random, so the blink challenge is addressed by kind (a head challenge would also need moves).
    """
    challenge = next(c["id"] for c in created["plan"]["challenges"] if c["kind"] == "cued_blink")
    events, at = [{"challenge_id": challenge, "type": "challenge_end", "client_ts_ms": 1_000_100, "payload": {}}], 1_000_100
    for index, latency in enumerate(latencies):
        at += 20
        events.append({"challenge_id": challenge, "type": "cue", "client_ts_ms": at, "payload": {"index": index}})
        events.append({"challenge_id": challenge, "type": "response", "client_ts_ms": at + latency, "payload": {"index": index}})
    return events


def test_health_and_json_error_shape(client):
    assert client.get("/api/health").json()["status"] == "ok"
    for response in (client.get("/api/nope"), client.post("/api/sessions", json={}),
                     client.get("/api/sessions/not-a-uuid/plan")):
        assert set(response.json()) == {"error", "detail"}


def test_plan_shape_is_random_and_well_formed():
    orders = set()
    for _ in range(60):
        plan = create_plan()
        by_kind = {c["kind"]: c for c in plan["challenges"]}
        assert set(by_kind) == {"head_sequence", "cued_blink", "digits"} and plan["pulse_hold_ms"] == 12000
        moves = by_kind["head_sequence"]["moves"]
        assert len(moves) == 3 and set(moves) <= set(MOVES) and all(a != b for a, b in zip(moves, moves[1:]))
        offsets = by_kind["cued_blink"]["cue_offsets_ms"]
        assert len(offsets) == 3 and all(1500 <= b - a <= 4000 for a, b in zip([0, *offsets], offsets))
        assert len(by_kind["digits"]["digits"]) == 4 and by_kind["digits"]["digits"].isdigit()
        assert len({c["id"] for c in plan["challenges"]}) == 3
        orders.add(tuple(c["kind"] for c in plan["challenges"]))
    assert len(orders) > 1


def test_create_session_stores_offset_and_coarse_user_agent(client, sql):
    before = int(time.time() * 1000)
    created = client.post("/api/sessions", json={"client_now_ms": before - 5000, "presenter_label": "  Asha  "},
                          headers={"User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36"}).json()
    assert abs(created["server_now_ms"] - before) < 5000 and len(created["plan"]["challenges"]) == 3
    row = sql("SELECT status, plan_consumed, clock_offset_ms, presenter_label, ua_family, expires_at - created_at FROM sessions")[0]
    assert row[:2] == ("opened", 1) and 5000 <= row[2] < 10000
    assert row[3:] == ("Asha", "Chrome/Android", 300_000)


def test_ua_family_never_keeps_the_full_string():
    assert ua_family("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1") == "Safari/iOS"
    assert ua_family("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36 Edg/141.0") == "Edge/Windows"
    assert ua_family(None) == "Unknown"


def test_rate_limit_is_20_per_minute_per_ip(client):
    codes = [client.post("/api/sessions", json={"client_now_ms": 1}).status_code for _ in range(21)]
    assert codes == [201] * 20 + [429]


def test_token_bucket_refills():
    clock = [0.0]
    limiter = RateLimiter(20, clock=lambda: clock[0])
    assert [limiter.allow("a") for _ in range(21)] == [True] * 20 + [False]
    assert limiter.allow("b")
    clock[0] = 3.0
    assert limiter.allow("a") and not limiter.allow("a")


def test_link_plan_is_single_use(client, sql):
    link = client.post("/api/links", json={"label": "Help desk #4"}, headers=ADMIN).json()
    assert link["verify_url"] == f"https://frontend.example/verify/?s={link['session_id']}"
    assert sql("SELECT status, plan_consumed, link_label FROM sessions") == [("created", 0, "Help desk #4")]
    path = f"/api/sessions/{link['session_id']}/plan"
    assert client.post(f"/api/sessions/{link['session_id']}/events", json={"events": [
        {"challenge_id": "x", "type": "cue", "client_ts_ms": 1, "payload": {}}]}).status_code == 409
    first = client.get(path, params={"client_now_ms": 1})
    assert first.status_code == 200 and len(first.json()["plan"]["challenges"]) == 3
    second = client.get(path)
    assert second.status_code == 409 and second.json()["error"] == "plan_consumed"
    assert sql("SELECT status, plan_consumed FROM sessions") == [("opened", 1)]


def test_plan_of_a_directly_created_session_cannot_be_fetched_again(client, session):
    assert client.get(f"/api/sessions/{session['session_id']}/plan").status_code == 409


def test_expired_session_is_gone(client, session, sql):
    sql("UPDATE sessions SET expires_at = 1")
    events = [{"challenge_id": session["plan"]["challenges"][0]["id"], "type": "cue", "client_ts_ms": 1, "payload": {}}]
    assert report(client, session, events).status_code == 410
    done = client.post(f"/api/sessions/{session['session_id']}/complete", json={"signals": SIGNALS})
    assert done.status_code == 410 and done.json()["error"] == "session_expired"
    assert sql("SELECT status FROM sessions") == [("expired",)]


def test_events_are_stored_and_move_the_session_forward(client, session, sql):
    assert report(client, session, cued_events(session)).json() == {"accepted": 7}
    assert sql("SELECT COUNT(*), MIN(server_ts_ms) > 0 FROM events") == [(7, 1)]
    assert sql("SELECT status FROM sessions") == [("in_progress",)]


@pytest.mark.parametrize("payload,status", [
    ({"note": "x" * 65}, 422),
    ({"frame": "data:image/png;base64,iVBORw0KGgo="}, 422),
    ({"blob": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"}, 422),
    ({"nested": {"a": 1}}, 422),
    ({"list": [1, 2, 3]}, 422),
    ({f"k{i}": "y" * 60 for i in range(200)}, 413),
])
def test_event_payload_limits(client, session, sql, payload, status):
    challenge = session["plan"]["challenges"][0]["id"]
    response = report(client, session, [{"challenge_id": challenge, "type": "cue", "client_ts_ms": 1, "payload": payload}])
    assert response.status_code == status and sql("SELECT COUNT(*) FROM events") == [(0,)]


def test_event_envelope_limits(client, session, sql):
    challenge = session["plan"]["challenges"][0]["id"]
    ok = {"challenge_id": challenge, "type": "cue", "client_ts_ms": 1, "payload": {"index": 0, "move": "left"}}
    for bad in ({**ok, "challenge_id": "c_unknown"}, {**ok, "type": "screenshot"}, {**ok, "challenge_id": "c" * 65},
                {**ok, "image": "AAAA"}):
        assert report(client, session, [ok, bad]).status_code == 422
    assert sql("SELECT COUNT(*) FROM events") == [(0,)]
    oversized = client.post(f"/api/sessions/{session['session_id']}/events", content=b"x" * 300_000,
                            headers={"Content-Type": "image/png"})
    assert oversized.status_code == 413


def test_complete_recomputes_server_side_and_signs(client, session, sql):
    report(client, session, cued_events(session))
    body = {"signals": [*SIGNALS[:3], {"id": SIGNAL_IDS[3], "risk": 0, "provenance": "simulated", "detail": "sim"},
                        {"id": SIGNAL_IDS[4], "risk": 0, "provenance": "server", "detail": "client cannot claim this"}],
            "challenge_results": [{"kind": "head", "status": "observed", "risk": 10, "detail": "ok"}]}
    response = client.post(f"/api/sessions/{session['session_id']}/complete", json=body)
    assert response.status_code == 200
    result = response.json()
    # 12 * (15 + 30 + 10) / 100 + 60 * 45 / 100; simulated, client-claimed "server" and missing texture inputs are excluded.
    assert (result["decision"], result["risk"], result["coverage"]) == ("step-up", 34, 55)
    assert result["policy_version"] == POLICY_VERSION and result["mode"] == "live"
    freshness = result["signals"][-1]
    assert (freshness["id"], freshness["risk"], freshness["provenance"]) == ("freshness", 10, "server")
    assert [s["id"] for s in result["signals"][:-1]] == list(SIGNAL_IDS)
    assert any(reason.startswith("Freshness (server-checked): clean") for reason in result["reasons"])
    assert sql("SELECT status, decision, risk, coverage, policy_version FROM sessions") == \
        [("completed", "step-up", 34, 55, POLICY_VERSION)]

    jwk = client.get("/api/keys").json()["keys"][0]
    assert (jwk["kty"], jwk["crv"], jwk["alg"]) == ("OKP", "Ed25519", "EdDSA")
    public = Ed25519PublicKey.from_public_bytes(base64.urlsafe_b64decode(jwk["x"] + "=" * (-len(jwk["x"]) % 4)))
    claims = jwt.decode(result["token"], public, algorithms=["EdDSA"])
    assert claims["sub"] == session["session_id"] and claims["exp"] == claims["iat"] + 600
    assert (claims["decision"], claims["risk"], claims["policy_version"]) == ("step-up", 34, POLICY_VERSION)
    assert jwt.get_unverified_header(result["token"])["kid"] == jwk["kid"]

    assert client.post("/api/tokens/verify", json={"token": result["token"]}).json() == {"valid": True, "claims": claims}
    tampered = result["token"][:-4] + ("AAAA" if not result["token"].endswith("AAAA") else "BBBB")
    assert client.post("/api/tokens/verify", json={"token": tampered}).json() == {"valid": False, "claims": None}
    assert client.post("/api/tokens/verify", json={"token": "not.a.jwt"}).json()["valid"] is False

    again = client.post(f"/api/sessions/{session['session_id']}/complete", json=body)
    assert again.status_code == 410 and again.json()["error"] == "session_completed"
    assert report(client, session, cued_events(session)).status_code == 410


def test_expired_and_foreign_tokens_do_not_verify(client, settings):
    signer = client.app.state.signer
    assert client.post("/api/tokens/verify", json={"token": signer.sign("s", "step-up", 60, "x", now_s=1000)}).json()["valid"] is False
    with TestClient(create_app(type(settings)(db_path=settings.db_path))) as other:
        foreign = other.app.state.signer.sign("s", "approve", 1, "x")
    assert client.post("/api/tokens/verify", json={"token": foreign}).json()["valid"] is False


def test_timing_flags_reach_the_decision(client, session):
    report(client, session, cued_events(session, latencies=(400, 60, 520)))
    result = client.post(f"/api/sessions/{session['session_id']}/complete", json={"signals": SIGNALS}).json()
    freshness = result["signals"][-1]
    assert freshness["risk"] == 85 and any("anticipatory" in flag for flag in freshness["flags"])
    assert result["decision"] != "approve" and any("Freshness (server-checked): flagged" in r for r in result["reasons"])


def test_complete_rejects_media_and_oversized_text(client, session):
    path = f"/api/sessions/{session['session_id']}/complete"
    for detail in ("data:image/jpeg;base64,/9j/4AAQSkZJRg==", "x" * 401, "A" * 120):
        signals = [{**SIGNALS[0], "detail": detail}, *SIGNALS[1:]]
        assert client.post(path, json={"signals": signals}).status_code == 422
    assert client.post(path, json={"signals": SIGNALS, "frame": "AAAA"}).status_code == 422


def test_cancel_closes_the_session(client, session):
    assert client.post(f"/api/sessions/{session['session_id']}/cancel").json()["status"] == "cancelled"
    assert client.post(f"/api/sessions/{session['session_id']}/complete", json={"signals": SIGNALS}).status_code == 410


@pytest.mark.parametrize("method,path", [
    ("get", "/api/admin/sessions"), ("get", "/api/admin/sessions/00000000-0000-4000-8000-000000000000"),
    ("get", "/api/admin/summary"), ("post", "/api/links"), ("get", "/api/admin/stream"),
])
def test_admin_auth_required(client, method, path):
    for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": "Basic test-admin-token"}):
        response = getattr(client, method)(path, headers=headers)
        assert response.status_code == 401 and response.json()["error"] == "unauthorized"
    # The query-string token is accepted by the stream endpoint ONLY.
    if not path.endswith("/stream"):
        assert getattr(client, method)(path, params={"token": "test-admin-token"}).status_code == 401
    else:
        assert client.get(path, params={"token": "wrong"}).status_code == 401


def test_admin_is_disabled_without_a_configured_token(settings):
    with TestClient(create_app(type(settings)(db_path=settings.db_path))) as anonymous:
        assert anonymous.get("/api/admin/sessions", headers={"Authorization": "Bearer "}).status_code == 503
        assert anonymous.get("/api/admin/stream", params={"token": ""}).status_code == 503


def test_admin_views(client, session):
    report(client, session, cued_events(session))
    client.post(f"/api/sessions/{session['session_id']}/complete", json={"signals": SIGNALS})
    newer = client.post("/api/sessions", json={"client_now_ms": 1, "presenter_label": "Asha"}).json()

    listing = client.get("/api/admin/sessions", headers=ADMIN).json()["sessions"]
    assert [s["id"] for s in listing] == [newer["session_id"], session["session_id"]]
    assert "events" not in listing[0] and "plan" not in listing[0] and listing[1]["decision"] == "step-up"
    assert len(client.get("/api/admin/sessions", params={"limit": 1}, headers=ADMIN).json()["sessions"]) == 1

    detail = client.get(f"/api/admin/sessions/{session['session_id']}", headers=ADMIN).json()
    assert len(detail["events"]) == 7 and detail["status"] == "completed"
    assert detail["result"]["signals"][-1]["id"] == "freshness"
    assert client.get("/api/admin/sessions/00000000-0000-4000-8000-000000000000", headers=ADMIN).status_code == 404

    summary = client.get("/api/admin/summary", headers=ADMIN).json()
    assert summary["total"] == 2
    assert {"presenter_label": "Asha", "decision": None, "count": 1} in summary["by_presenter_decision"]
    assert {"presenter_label": None, "decision": "step-up", "count": 1} in summary["by_presenter_decision"]


def test_broadcast_fans_out_and_drops_when_full():
    bus = Broadcast()
    first, second = bus.subscribe(), bus.subscribe()
    bus.publish({"type": "session.created"})
    assert first.get_nowait() == second.get_nowait() == {"type": "session.created"}
    for _ in range(150):
        bus.publish({"type": "noise"})
    assert first.qsize() == 100
    bus.unsubscribe(first)
    bus.unsubscribe(second)
    assert not bus.subscribers


def test_session_lifecycle_is_broadcast(client, session):
    queue = client.app.state.bus.subscribe()
    report(client, session, cued_events(session))
    client.post(f"/api/sessions/{session['session_id']}/complete", json={"signals": SIGNALS})
    client.post("/api/sessions", json={"client_now_ms": 1})
    seen = [queue.get_nowait() for _ in range(queue.qsize())]
    assert [m["type"] for m in seen] == ["session.status", "session.completed", "session.created"]
    assert seen[1]["session"]["decision"] == "step-up" and "challenges" not in json.dumps(seen)


def test_retention_purges_old_sessions_and_events(client, session, sql):
    report(client, session, cued_events(session))
    fresh = client.post("/api/sessions", json={"client_now_ms": 1}).json()
    sql("UPDATE sessions SET created_at = created_at - ? WHERE id = ?", (25 * 3600 * 1000, session["session_id"]))
    assert client.app.state.db.purge_older_than(int(time.time() * 1000) - 24 * 3600 * 1000) == 1
    assert sql("SELECT id FROM sessions") == [(fresh["session_id"],)] and sql("SELECT COUNT(*) FROM events") == [(0,)]


def test_cors_allows_only_configured_origins(client):
    allowed = client.options("/api/sessions", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"})
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:3000"
    denied = client.options("/api/sessions", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in denied.headers


def test_digit_metrics_are_accepted_as_numbers_only(client, session, sql):
    challenge = next(c["id"] for c in session["plan"]["challenges"] if c["kind"] == "digits")
    payload = {"status": "observed", "peakCorr": 0.612, "lagMs": -40, "voicedFraction": 0.41, "digitsMatched": 4}
    event = {"challenge_id": challenge, "type": "challenge_end", "client_ts_ms": 1_000_100, "payload": payload}
    assert report(client, session, [event, {**event, "payload": {**payload, "peakCorr": None, "lagMs": None}}]).status_code == 202
    assert json.loads(sql("SELECT payload_json FROM events ORDER BY id")[0][0]) == payload
