"""Environment-driven settings. Secrets (ADMIN_TOKEN, SIGNING_KEY_B64) stay server-side only."""
from __future__ import annotations

import os
from dataclasses import dataclass

SESSION_TTL_MS = 5 * 60 * 1000
TOKEN_TTL_S = 600
MAX_BODY_BYTES = 256 * 1024
MAX_PAYLOAD_BYTES = 8 * 1024
MAX_STRING_CHARS = 64
MAX_EVENTS_PER_SESSION = 500


@dataclass(frozen=True)
class Settings:
    db_path: str = "./aegis.db"
    retention_hours: float = 24.0
    signing_key_b64: str = ""
    admin_token: str = ""
    allowed_origins: tuple[str, ...] = ("http://localhost:3000", "http://127.0.0.1:3000")
    frontend_origin: str = "http://localhost:3000"
    rate_limit_per_min: int = 20

    @classmethod
    def from_env(cls) -> "Settings":
        env = os.environ
        origins = tuple(o.strip().rstrip("/") for o in env.get("ALLOWED_ORIGINS", "").split(",") if o.strip())
        return cls(
            db_path=env.get("DB_PATH", cls.db_path),
            retention_hours=float(env.get("RETENTION_HOURS", cls.retention_hours)),
            signing_key_b64=env.get("SIGNING_KEY_B64", "").strip(),
            admin_token=env.get("ADMIN_TOKEN", "").strip(),
            allowed_origins=origins or cls.allowed_origins,
            frontend_origin=env.get("FRONTEND_ORIGIN", cls.frontend_origin).strip().rstrip("/"),
        )
