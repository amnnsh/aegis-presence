
"""Aegis presence API: single-use plans, timing checks, signed outcomes.

Stores structured scores and timing events, never raw media.
Gemini reports are advisory and cannot modify policy decisions.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import (
    MAX_BODY_BYTES,
    MAX_EVENTS_PER_SESSION,
    MAX_PAYLOAD_BYTES,
    MAX_STRING_CHARS,
    SESSION_TTL_MS,
    Settings,
)
from .attacks import apply_attack_policy, fuse_attack_checks
from .db import ACTIVE, Database
from .gemini_analyst import (
    GeminiAnalystError,
    generate_analyst_report,
    prepare_evidence,
)
from .plan import create_plan
from .policy import (
    POLICY_VERSION,
    PROVENANCES,
    apply_freshness,
    evaluate_risk,
)
from .signing import Signer
from .timing import EVENT_TYPES, check_freshness


log = logging.getLogger("aegis")

MAX_TS_MS = 10**14
MEDIA_HINT = re.compile(
    r"data:[a-z]+/|;base64,|[A-Za-z0-9+/_-]{80,}",
    re.IGNORECASE,
)
BASE64_TOKEN = re.compile(r"[A-Za-z0-9+/_-]{24,}={0,2}")

GEMINI_CACHE_TTL = 1800
GEMINI_CACHE_MAX = 200
GEMINI_RATE_PER_MINUTE = 5


class ApiError(Exception):
    def __init__(self, status: int, error: str, detail: str):
        self.status = status
        self.error = error
        self.detail = detail


def _error(
    status: int,
    error: str,
    detail: str,
    headers: dict | None = None,
) -> JSONResponse:
    return JSONResponse(
        {"error": error, "detail": detail},
        status_code=status,
        headers=headers,
    )


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateSessionIn(_Strict):
    client_now_ms: int = Field(ge=0, le=MAX_TS_MS)
    presenter_label: str | None = Field(
        default=None,
        max_length=MAX_STRING_CHARS,
    )


class EventIn(_Strict):
    challenge_id: str = Field(
        min_length=1,
        max_length=MAX_STRING_CHARS,
    )
    type: Literal[EVENT_TYPES]  # type: ignore[valid-type]
    client_ts_ms: int = Field(ge=0, le=MAX_TS_MS)
    payload: dict[str, Any] = Field(default_factory=dict)


class EventsIn(_Strict):
    events: list[EventIn] = Field(min_length=1, max_length=100)


class SignalIn(_Strict):
    id: str = Field(min_length=1, max_length=32)
    risk: StrictInt | StrictFloat | None = None
    provenance: Literal[PROVENANCES]  # type: ignore[valid-type]
    detail: str = Field(default="", max_length=400)


class ChallengeResultIn(_Strict):
    kind: str = Field(min_length=1, max_length=32)
    status: Literal["observed", "partial", "unavailable"]
    risk: StrictInt | StrictFloat | None = None
    detail: str = Field(default="", max_length=400)


class AttackIndicatorIn(_Strict):
    id: str = Field(min_length=1, max_length=32)
    ran: StrictBool
    fired: StrictBool


class AttackCheckIn(_Strict):
    id: str = Field(min_length=1, max_length=32)
    indicators: list[AttackIndicatorIn] = Field(max_length=12)


class CompleteIn(_Strict):
    signals: list[SignalIn] = Field(max_length=16)
    challenge_results: list[ChallengeResultIn] = Field(
        default_factory=list,
        max_length=16,
    )
    attack_checks: list[AttackCheckIn] = Field(default_factory=list, max_length=2)


class LinkIn(_Strict):
    label: str = Field(min_length=1, max_length=MAX_STRING_CHARS)


class TokenIn(_Strict):
    token: str = Field(min_length=1, max_length=4096)


def now_ms() -> int:
    return int(time.time() * 1000)


def iso(ms: int) -> str:
    return (
        datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def clean_label(value: str | None) -> str | None:
    cleaned = "".join(
        ch for ch in (value or "") if ch.isprintable()
    ).strip()
    return cleaned or None


def ua_family(user_agent: str | None) -> str:
    """Coarse Browser/OS bucket; never store the full user agent."""
    ua = (user_agent or "").lower()
    if not ua:
        return "Unknown"

    browser = (
        "Edge" if "edg" in ua
        else "Opera" if "opr/" in ua
        else "Firefox" if "firefox" in ua or "fxios" in ua
        else "Chrome" if "chrome" in ua or "crios" in ua
        else "Safari" if "safari" in ua
        else "Other"
    )
    system = (
        "Android" if "android" in ua
        else "iOS" if any(k in ua for k in ("iphone", "ipad", "ipod"))
        else "Windows" if "windows" in ua
        else "macOS" if "mac os x" in ua or "macintosh" in ua
        else "ChromeOS" if "cros" in ua
        else "Linux" if "linux" in ua
        else "Other"
    )
    return f"{browser}/{system}"


def validate_payload(payload: dict) -> None:
    """Allow only flat, bounded event data."""
    if len(json.dumps(payload, separators=(",", ":")).encode()) > MAX_PAYLOAD_BYTES:
        raise ApiError(413, "payload_too_large", "Event payload exceeds 8 KB.")
    if len(payload) > 16:
        raise ApiError(422, "invalid_payload", "Event payload has too many fields.")

    for key, value in payload.items():
        if len(key) > MAX_STRING_CHARS:
            raise ApiError(422, "invalid_payload", "Payload field names are limited to 64 characters.")
        if value is None or isinstance(value, (bool, int, float)):
            continue
        if not isinstance(value, str):
            raise ApiError(422, "invalid_payload", "Payload values must be numbers, booleans, or short strings.")
        if len(value) > MAX_STRING_CHARS:
            raise ApiError(422, "invalid_payload", "String fields are limited to 64 characters.")
        if MEDIA_HINT.search(value) or BASE64_TOKEN.fullmatch(value):
            raise ApiError(422, "media_rejected", "Encoded media is not accepted. Send numbers and short enums only.")


class RateLimiter:
    """Single-process token bucket per key."""

    def __init__(self, per_minute: int, clock=time.monotonic):
        self.capacity = float(per_minute)
        self.rate = per_minute / 60.0
        self.clock = clock
        self.buckets: dict[str, tuple[float, float]] = {}

    def allow(self, key: str) -> bool:
        now = self.clock()
        if len(self.buckets) > 10000:
            self.buckets = {
                k: v for k, v in self.buckets.items()
                if now - v[1] < 60
            }
        tokens, last = self.buckets.get(
            key, (self.capacity, now)
        )
        tokens = min(
            self.capacity,
            tokens + (now - last) * self.rate,
        )
        allowed = tokens >= 1
        self.buckets[key] = (
            tokens - 1 if allowed else tokens,
            now,
        )
        return allowed


class Broadcast:
    """In-process fan-out for admin SSE."""

    MAX_SUBSCRIBERS = 20

    def __init__(self):
        self.subscribers: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue | None:
        if len(self.subscribers) >= self.MAX_SUBSCRIBERS:
            return None
        queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self.subscribers.discard(queue)

    def publish(self, message: dict) -> None:
        for queue in self.subscribers:
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                pass


class BodyLimit:
    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            length = dict(scope["headers"]).get(
                b"content-length", b""
            )
            if length.isdigit() and int(length) > self.max_bytes:
                await _error(
                    413,
                    "payload_too_large",
                    "Request body is too large.",
                )(scope, receive, send)
                return
        await self.app(scope, receive, send)


class _RedactToken(logging.Filter):
    """Redact SSE tokens from access logs."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(
                re.sub(
                    r'token=[^&\s"]+',
                    "token=[redacted]",
                    a,
                ) if isinstance(a, str) else a
                for a in record.args
            )
        return True


def session_view(row: dict) -> dict:
    status = (
        "expired"
        if row["status"] in ACTIVE and now_ms() > row["expires_at"]
        else row["status"]
    )
    return {
        "id": row["id"],
        "created_at": iso(row["created_at"]),
        "expires_at": iso(row["expires_at"]),
        "status": status,
        "plan_consumed": bool(row["plan_consumed"]),
        "decision": row["decision"],
        "risk": row["risk"],
        "coverage": row["coverage"],
        "policy_version": row["policy_version"],
        "presenter_label": row["presenter_label"],
        "link_label": row["link_label"],
        "ua_family": row["ua_family"],
    }


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    db = Database(settings.db_path)
    signer = Signer.from_b64(settings.signing_key_b64)
    bus = Broadcast()
    limiter = RateLimiter(settings.rate_limit_per_min)

    # Gemini safeguards are isolated to this application instance.
    gemini_limiter = RateLimiter(GEMINI_RATE_PER_MINUTE)

    # session_id -> (expiry, fingerprint, response)
    gemini_cache: dict[
        str, tuple[float, str, dict]
    ] = {}

    # Per-session locks prevent duplicate concurrent generation.
    gemini_locks: dict[str, asyncio.Lock] = {}

    logging.getLogger("uvicorn.access").addFilter(
        _RedactToken()
    )

    if not settings.admin_token:
        log.warning(
            "ADMIN_TOKEN is not set: admin endpoints are disabled."
        )

    def purge_gemini_cache() -> None:
        now = time.monotonic()

        expired = [
            session_id
            for session_id, (expiry, _, _) in gemini_cache.items()
            if expiry <= now
        ]

        for session_id in expired:
            gemini_cache.pop(session_id, None)

        # Keep the cache bounded.
        if len(gemini_cache) > GEMINI_CACHE_MAX:
            oldest = sorted(
                gemini_cache,
                key=lambda key: gemini_cache[key][0],
            )
            for session_id in oldest[
                :len(gemini_cache) - GEMINI_CACHE_MAX
            ]:
                gemini_cache.pop(session_id, None)

    def purge() -> None:
        removed = db.purge_older_than(
            now_ms() - int(
                settings.retention_hours * 3600 * 1000
            )
        )
        purge_gemini_cache()
        if removed:
            log.info(
                "Retention: removed %d session(s) older than %s h",
                removed,
                settings.retention_hours,
            )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        async def hourly():
            while True:
                await asyncio.sleep(3600)
                try:
                    purge()
                except Exception:
                    log.exception("Retention sweep failed")

        purge()
        task = asyncio.create_task(hourly())
        try:
            yield
        finally:
            task.cancel()

    app = FastAPI(
        title="Aegis presence API",
        version=POLICY_VERSION,
        lifespan=lifespan,
    )

    app.state.db = db
    app.state.signer = signer
    app.state.bus = bus
    app.state.limiter = limiter

    app.add_middleware(
        BodyLimit,
        max_bytes=MAX_BODY_BYTES,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=600,
    )

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        return _error(exc.status, exc.error, exc.detail)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(
        _: Request,
        exc: StarletteHTTPException,
    ):
        return _error(
            exc.status_code,
            "http_error",
            str(exc.detail),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(
        _: Request,
        exc: RequestValidationError,
    ):
        problems = "; ".join(
            f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}"
            for e in exc.errors()[:5]
        )
        return _error(422, "validation_error", problems)

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception):
        log.exception("Unhandled error", exc_info=exc)
        return _error(
            500,
            "internal_error",
            "Unexpected server error.",
        )

    def publish(kind: str, session_id: str) -> None:
        row = db.get_session(session_id)
        if row:
            bus.publish({
                "type": kind,
                "session": session_view(row),
            })

    def require_admin(request: Request) -> None:
        if not settings.admin_token:
            raise ApiError(
                503,
                "admin_disabled",
                "ADMIN_TOKEN is not configured on this server.",
            )

        scheme, _, supplied = request.headers.get(
            "authorization", ""
        ).partition(" ")

        if (
            scheme.lower() != "bearer"
            or not hmac.compare_digest(
                supplied.strip().encode(),
                settings.admin_token.encode(),
            )
        ):
            raise ApiError(
                401,
                "unauthorized",
                "A valid admin bearer token is required.",
            )

    def load(session_id: str) -> dict:
        try:
            session_id = str(uuid.UUID(session_id))
        except ValueError:
            raise ApiError(
                404,
                "not_found",
                "Unknown session.",
            ) from None

        row = db.get_session(session_id)
        if not row:
            raise ApiError(
                404,
                "not_found",
                "Unknown session.",
            )

        if (
            row["status"] in ACTIVE
            and now_ms() > row["expires_at"]
        ):
            if db.update_session(
                session_id,
                {"status": "expired"},
                only_status=ACTIVE,
            ):
                publish("session.status", session_id)
            row["status"] = "expired"

        return row

    def load_open(session_id: str) -> dict:
        row = load(session_id)

        if row["status"] in (
            "expired", "completed", "cancelled"
        ):
            raise ApiError(
                410,
                f"session_{row['status']}",
                f"This session is {row['status']}.",
            )
        return row

    def new_session(
        clock_offset_ms: int | None,
        presenter_label: str | None,
        link_label: str | None,
        user_agent: str | None,
        delivered: bool,
    ) -> dict:
        created = now_ms()
        session = {
            "id": str(uuid.uuid4()),
            "created_at": created,
            "expires_at": created + SESSION_TTL_MS,
            "status": "opened" if delivered else "created",
            "plan_json": json.dumps(create_plan()),
            "plan_consumed": int(delivered),
            "clock_offset_ms": clock_offset_ms,
            "presenter_label": presenter_label,
            "link_label": link_label,
            "ua_family": user_agent,
        }
        db.create_session(session)
        publish("session.created", session["id"])
        return session

    @app.get("/api/health")
    async def health():
        return {
            "status": "ok",
            "policy_version": POLICY_VERSION,
            "server_now_ms": now_ms(),
        }

    @app.post("/api/sessions", status_code=201)
    async def create_session(
        body: CreateSessionIn,
        request: Request,
    ):
        client_ip = (
            request.client.host
            if request.client
            else "unknown"
        )

        if not limiter.allow(client_ip):
            return _error(
                429,
                "rate_limited",
                "Too many sessions from this address. Try again in a minute.",
                headers={"Retry-After": "60"},
            )

        server_now = now_ms()
        session = new_session(
            server_now - body.client_now_ms,
            clean_label(body.presenter_label),
            None,
            ua_family(request.headers.get("user-agent")),
            delivered=True,
        )
        return {
            "session_id": session["id"],
            "expires_at": iso(session["expires_at"]),
            "server_now_ms": server_now,
            "plan": json.loads(session["plan_json"]),
        }

    @app.get("/api/sessions/{session_id}/plan")
    async def get_plan(
        session_id: str,
        request: Request,
        client_now_ms: int | None = Query(
            default=None,
            ge=0,
            le=MAX_TS_MS,
        ),
    ):
        row = load_open(session_id)
        server_now = now_ms()

        fields = {
            "plan_consumed": 1,
            "status": "opened",
            "ua_family": ua_family(
                request.headers.get("user-agent")
            ),
            "clock_offset_ms": (
                None if client_now_ms is None
                else server_now - client_now_ms
            ),
        }

        if not db.update_session(
            row["id"],
            fields,
            only_status=("created",),
            only_unconsumed=True,
        ):
            raise ApiError(
                409,
                "plan_consumed",
                "This plan was already delivered. Create a new session.",
            )

        publish("session.status", row["id"])

        return {
            "session_id": row["id"],
            "expires_at": iso(row["expires_at"]),
            "server_now_ms": server_now,
            "plan": json.loads(row["plan_json"]),
        }

    @app.post(
        "/api/sessions/{session_id}/events",
        status_code=202,
    )
    async def post_events(
        session_id: str,
        body: EventsIn,
    ):
        row = load_open(session_id)

        if not row["plan_consumed"]:
            raise ApiError(
                409,
                "plan_not_opened",
                "Fetch the plan before reporting events.",
            )

        known = {
            c["id"]
            for c in json.loads(
                row["plan_json"]
            )["challenges"]
        }

        events = [
            e.model_dump()
            for e in body.events
        ]

        for event in events:
            if event["challenge_id"] not in known:
                raise ApiError(
                    422,
                    "unknown_challenge",
                    "challenge_id is not part of this session's plan.",
                )
            validate_payload(event["payload"])

        if (
            db.count_events(row["id"]) + len(events)
            > MAX_EVENTS_PER_SESSION
        ):
            raise ApiError(
                413,
                "too_many_events",
                "This session has reached its event limit.",
            )

        db.add_events(row["id"], events, now_ms())

        if db.update_session(
            row["id"],
            {"status": "in_progress"},
            only_status=("opened",),
        ):
            publish("session.status", row["id"])

        return {"accepted": len(events)}

    @app.post("/api/sessions/{session_id}/cancel")
    async def cancel(session_id: str):
        row = load_open(session_id)

        if db.update_session(
            row["id"],
            {"status": "cancelled"},
            only_status=ACTIVE,
        ):
            publish("session.status", row["id"])

        return {
            "session_id": row["id"],
            "status": "cancelled",
        }

    @app.post("/api/sessions/{session_id}/complete")
    async def complete(
        session_id: str,
        body: CompleteIn,
    ):
        row = load_open(session_id)

        if not row["plan_consumed"]:
            raise ApiError(
                409,
                "plan_not_opened",
                "Fetch the plan before completing a session.",
            )

        signals = []
        for s in body.signals:
            if MEDIA_HINT.search(s.detail):
                raise ApiError(
                    422,
                    "media_rejected",
                    "Encoded media is not accepted.",
                )

            provenance = (
                "unavailable"
                if s.provenance == "server"
                else s.provenance
            )

            signals.append({
                "id": s.id,
                "risk": s.risk,
                "provenance": provenance,
                "detail": s.detail,
            })

        if any(
            MEDIA_HINT.search(r.detail)
            for r in body.challenge_results
        ):
            raise ApiError(
                422,
                "media_rejected",
                "Encoded media is not accepted.",
            )

        freshness = check_freshness(
            json.loads(row["plan_json"]),
            db.list_events(row["id"]),
            row["created_at"],
            now_ms(),
            row["clock_offset_ms"],
        )

        attack_checks = fuse_attack_checks([check.model_dump() for check in body.attack_checks])
        result = apply_freshness(
            apply_attack_policy(evaluate_risk(signals, "live"), attack_checks),
            freshness,
        )

        result["signals"] = [
            *result["signals"],
            freshness,
        ]

        stored = {
            **result,
            "challenge_results": [
                {
                    "kind": r.kind,
                    "status": r.status,
                    "risk": r.risk,
                }
                for r in body.challenge_results
            ],
        }

        update = {
            "status": "completed",
            "decision": result["decision"],
            "risk": result["risk"],
            "coverage": result["coverage"],
            "policy_version": POLICY_VERSION,
            "result_json": json.dumps(stored),
        }

        if not db.update_session(
            row["id"],
            update,
            only_status=("opened", "in_progress"),
        ):
            raise ApiError(
                410,
                "session_completed",
                "This session is completed.",
            )

        publish("session.completed", row["id"])

        token = signer.sign(
            row["id"],
            result["decision"],
            result["risk"],
            POLICY_VERSION,
        )

        return {
            "session_id": row["id"],
            **result,
            "policy_version": POLICY_VERSION,
            "token": token,
        }

    @app.get("/api/keys")
    async def keys():
        return {"keys": [signer.jwk]}

    @app.post("/api/tokens/verify")
    async def verify_token(body: TokenIn):
        claims = signer.verify(body.token)
        return {
            "valid": claims is not None,
            "claims": claims,
        }

    @app.get(
        "/api/admin/sessions",
        dependencies=[Depends(require_admin)],
    )
    async def admin_sessions(
        limit: int = Query(default=100, ge=1, le=500),
    ):
        return {
            "sessions": [
                session_view(r)
                for r in db.list_sessions(limit)
            ]
        }

    @app.get(
        "/api/admin/sessions/{session_id}",
        dependencies=[Depends(require_admin)],
    )
    async def admin_session(session_id: str):
        row = load(session_id)

        return {
            **session_view(row),
            "clock_offset_ms": row["clock_offset_ms"],
            "plan": json.loads(row["plan_json"]),
            "result": (
                json.loads(row["result_json"])
                if row["result_json"]
                else None
            ),
            "events": db.list_events(row["id"]),
        }

    # ------------------------------------------
    # Gemini Security Analyst endpoint
    # ------------------------------------------

    @app.post(
        "/api/admin/sessions/{session_id}/analyze",
        dependencies=[Depends(require_admin)],
    )
    async def analyze_session(session_id: str):
        """Generate or reuse an advisory Gemini report."""

        row = load(session_id)

        if row["status"] != "completed":
            raise ApiError(
                409,
                "session_not_completed",
                "Gemini analysis requires a completed session.",
            )

        if not row["result_json"]:
            raise ApiError(
                409,
                "result_unavailable",
                "This session has no stored verification result.",
            )

        try:
            policy_result = json.loads(
                row["result_json"]
            )
        except (ValueError, TypeError):
            raise ApiError(
                503,
                "result_invalid",
                "The stored verification result is invalid.",
            ) from None

        try:
            evidence = prepare_evidence(
                row["id"],
                policy_result,
            )
        except GeminiAnalystError:
            raise ApiError(
                503,
                "evidence_invalid",
                "Verification evidence could not be prepared.",
            ) from None

        evidence_json = json.dumps(
            evidence,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )

        fingerprint = hashlib.sha256(
            evidence_json.encode("utf-8")
        ).hexdigest()

        # Create one lock per active/cached session.
        # All lock access occurs on this event loop.
        lock = gemini_locks.setdefault(
            row["id"],
            asyncio.Lock(),
        )

        async with lock:
            purge_gemini_cache()

            now = time.monotonic()
            cached = gemini_cache.get(row["id"])

            if (
                cached is not None
                and cached[0] > now
                and cached[1] == fingerprint
            ):
                return cached[2]

            # Limit new generations globally per process.
            if not gemini_limiter.allow(
                "gemini-analysis"
            ):
                raise ApiError(
                    429,
                    "analyst_rate_limited",
                    "Too many Gemini analyses. Please retry later.",
                )

            try:
                report = await asyncio.to_thread(
                    generate_analyst_report,
                    evidence,
                )
            except GeminiAnalystError:
                raise ApiError(
                    503,
                    "analyst_unavailable",
                    "Gemini analysis is temporarily unavailable.",
                ) from None

            response = {
                "session_id": row["id"],
                "policy_decision": evidence[
                    "policy_decision"
                ],
                "policy_risk": evidence[
                    "policy_risk"
                ],
                "analyst": report.model_dump(),
                "advisory_only": True,
            }

            gemini_cache[row["id"]] = (
                time.monotonic() + GEMINI_CACHE_TTL,
                fingerprint,
                response,
            )

            purge_gemini_cache()

            return response

    @app.get(
        "/api/admin/summary",
        dependencies=[Depends(require_admin)],
    )
    async def admin_summary():
        rows = db.summary()
        return {
            "total": sum(r["count"] for r in rows),
            "by_presenter_decision": rows,
        }

    @app.post(
        "/api/links",
        status_code=201,
        dependencies=[Depends(require_admin)],
    )
    async def create_link(body: LinkIn):
        label = clean_label(body.label)

        if not label:
            raise ApiError(
                422,
                "validation_error",
                "label must contain printable characters.",
            )

        session = new_session(
            None,
            None,
            label,
            None,
            delivered=False,
        )

        return {
            "session_id": session["id"],
            "verify_url": (
                f"{settings.frontend_origin}/verify/"
                f"?s={session['id']}"
            ),
            "expires_at": iso(session["expires_at"]),
        }

    @app.get("/api/admin/stream")
    async def admin_stream(
        token: str = Query(
            default="",
            max_length=512,
        ),
    ):
        if not settings.admin_token:
            raise ApiError(
                503,
                "admin_disabled",
                "ADMIN_TOKEN is not configured on this server.",
            )

        if not hmac.compare_digest(
            token.encode(),
            settings.admin_token.encode(),
        ):
            raise ApiError(
                401,
                "unauthorized",
                "A valid admin token is required.",
            )

        queue = bus.subscribe()

        if queue is None:
            raise ApiError(
                503,
                "stream_busy",
                "Too many dashboard streams are open.",
            )

        async def stream():
            try:
                yield ": connected\n\n"

                while True:
                    try:
                        message = await asyncio.wait_for(
                            queue.get(),
                            timeout=15,
                        )
                        yield (
                            "data: "
                            + json.dumps(
                                message,
                                separators=(",", ":"),
                            )
                            + "\n\n"
                        )
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            finally:
                bus.unsubscribe(queue)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
            },
        )

    return app
