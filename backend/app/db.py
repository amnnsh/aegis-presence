"""sqlite storage for outcomes and timing events. Never images, video, or audio."""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager

ACTIVE = ("created", "opened", "in_progress")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,      -- epoch ms
  expires_at INTEGER NOT NULL,      -- epoch ms
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  plan_consumed INTEGER NOT NULL DEFAULT 0,
  clock_offset_ms INTEGER,
  decision TEXT,
  risk INTEGER,
  coverage INTEGER,
  policy_version TEXT,
  presenter_label TEXT,
  link_label TEXT,
  ua_family TEXT,
  result_json TEXT                  -- scores, provenance, reasons; no media
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL,
  type TEXT NOT NULL,
  client_ts_ms INTEGER NOT NULL,
  server_ts_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS sessions_created ON sessions(created_at);
"""


class Database:
    def __init__(self, path: str):
        self.path = path
        with self._connect() as db:
            db.executescript(SCHEMA)

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def create_session(self, session: dict) -> None:
        columns = ", ".join(session)
        marks = ", ".join("?" for _ in session)
        with self._connect() as db:
            db.execute(f"INSERT INTO sessions ({columns}) VALUES ({marks})", tuple(session.values()))

    def get_session(self, session_id: str) -> dict | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return dict(row) if row else None

    def update_session(self, session_id: str, fields: dict, only_status: tuple[str, ...] | None = None,
                       only_unconsumed: bool = False) -> bool:
        """Conditional update; returns False when the guard did not match (lost race / wrong state)."""
        sql = f"UPDATE sessions SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?"
        args = [*fields.values(), session_id]
        if only_status:
            sql += f" AND status IN ({', '.join('?' for _ in only_status)})"
            args += only_status
        if only_unconsumed:
            sql += " AND plan_consumed = 0"
        with self._connect() as db:
            return db.execute(sql, args).rowcount == 1

    def add_events(self, session_id: str, events: list[dict], server_ts_ms: int) -> None:
        rows = [(session_id, e["challenge_id"], e["type"], e["client_ts_ms"], server_ts_ms,
                 json.dumps(e["payload"], separators=(",", ":"))) for e in events]
        with self._connect() as db:
            db.executemany("INSERT INTO events (session_id, challenge_id, type, client_ts_ms, server_ts_ms, payload_json) "
                           "VALUES (?, ?, ?, ?, ?, ?)", rows)

    def count_events(self, session_id: str) -> int:
        with self._connect() as db:
            return db.execute("SELECT COUNT(*) FROM events WHERE session_id = ?", (session_id,)).fetchone()[0]

    def list_events(self, session_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute("SELECT id, challenge_id, type, client_ts_ms, server_ts_ms, payload_json FROM events "
                              "WHERE session_id = ? ORDER BY id", (session_id,)).fetchall()
        return [{"id": r["id"], "challenge_id": r["challenge_id"], "type": r["type"], "client_ts_ms": r["client_ts_ms"],
                 "server_ts_ms": r["server_ts_ms"], "payload": json.loads(r["payload_json"])} for r in rows]

    def list_sessions(self, limit: int) -> list[dict]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]

    def summary(self) -> list[dict]:
        with self._connect() as db:
            rows = db.execute("SELECT presenter_label, decision, COUNT(*) AS count FROM sessions "
                              "GROUP BY presenter_label, decision ORDER BY presenter_label, decision").fetchall()
        return [dict(r) for r in rows]

    def purge_older_than(self, cutoff_ms: int) -> int:
        with self._connect() as db:
            db.execute("DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE created_at < ?)", (cutoff_ms,))
            db.execute("DELETE FROM events WHERE server_ts_ms < ?", (cutoff_ms,))
            return db.execute("DELETE FROM sessions WHERE created_at < ?", (cutoff_ms,)).rowcount
