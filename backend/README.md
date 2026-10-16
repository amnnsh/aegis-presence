# Aegis presence API

A small FastAPI service that makes a verification session **fresh and checkable**:

- issues an unpredictable, single-use challenge plan per session (5-minute lifetime);
- stores **outcomes and timing events only** (numbers and short enums; never images, video, or audio);
- checks that reported event timing is consistent with the plan it issued;
- recomputes the decision server-side with a port of `lib/risk.ts` and signs it (EdDSA / Ed25519 JWT);
- feeds the operator dashboard (REST + Server-Sent Events).

## What it does not do

Read this before describing the system to anyone.

- **It does not authenticate the camera or the person.** The server never sees a frame. The "freshness"
  check tests whether *client-reported* events fit this session's plan and clock. A client that fabricates
  plausible events passes it.
- **Signal scores still come from the browser.** The server recomputes the decision from them, so a tampered
  client cannot flip `step-up` to `approve` by editing the result, but it can report false scores. A client may
  not claim `server` provenance; such inputs are treated as unavailable.
- **Live sessions never approve.** That rule is inherited from `lib/risk.ts` and is unchanged.
- **The token attests one thing:** this server computed this decision for this session id under this policy
  version. It is not an identity assertion or an access-control decision.
- No tenant auth, webhooks, or SDKs. One shared admin token. One process.

## Run locally

Python 3.11 or newer.

```sh
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate      macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env        # then fill in ADMIN_TOKEN and SIGNING_KEY_B64
uvicorn app.main:create_app --factory --env-file .env --port 8000
pytest
```

Then build the frontend against it (the URL is public and is baked into the bundle):

```sh
# repo root; PowerShell: $env:NEXT_PUBLIC_API_URL = "http://localhost:8000"
NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

`npm run dev` sends no CSP. For the production-header preview, set the variable for **both** commands:
`NEXT_PUBLIC_API_URL=http://localhost:8000 npm run build` and the same prefix on `npm run start`
(`scripts/serve.mjs` adds that origin to `connect-src` locally). If the variable is unset or the API is
unreachable, the app completes in local-only mode and the result says "Local only - not server-checked".

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `DB_PATH` | `./aegis.db` | sqlite file. |
| `RETENTION_HOURS` | `24` | Sessions and events older than this are deleted at startup and hourly. |
| `SIGNING_KEY_B64` | *(empty)* | Raw 32-byte Ed25519 seed, base64. Empty: an ephemeral key is generated with a loud warning, and tokens stop verifying on restart. |
| `ADMIN_TOKEN` | *(empty)* | Bearer token for admin endpoints. Empty: admin endpoints answer 503. |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Comma-separated CORS origins. |
| `FRONTEND_ORIGIN` | `http://localhost:3000` | Used to build help-desk links. |

`ADMIN_TOKEN` and `SIGNING_KEY_B64` are server secrets. Never put them in a `NEXT_PUBLIC_*` variable; the
dashboard asks the operator to type the admin token and keeps it in memory only.

## Endpoints

Errors are JSON: `{"error": "<code>", "detail": "<message>"}`.

| Method and path | Notes |
| --- | --- |
| `POST /api/sessions` | `{client_now_ms, presenter_label?}` -> `{session_id, expires_at, server_now_ms, plan}`. 20/min per IP. |
| `GET /api/sessions/{id}/plan` | Help-desk link flow. Returns the plan **once**; a second call is 409. Optional `?client_now_ms=` sets the clock offset. |
| `POST /api/sessions/{id}/events` | `{events: [{challenge_id, type, client_ts_ms, payload}]}`. 410 if expired/completed/cancelled, 422 for an unknown challenge, a string over 64 characters, nested data, or anything that looks like encoded media; 413 for a payload over 8 KB. |
| `POST /api/sessions/{id}/complete` | `{signals, challenge_results}` -> `{decision, risk, coverage, reasons, signals, policy_version, token, ...}`. |
| `POST /api/sessions/{id}/cancel` | Marks an unfinished session cancelled. |
| `GET /api/keys` | JWKS with the Ed25519 public key (`OKP`). |
| `POST /api/tokens/verify` | `{token}` -> `{valid, claims}`. |
| `GET /api/admin/sessions?limit=100` | Newest first, no events. `Authorization: Bearer <ADMIN_TOKEN>`. |
| `GET /api/admin/sessions/{id}` | With plan, stored result, and events. |
| `GET /api/admin/summary` | Counts by `presenter_label` x `decision`. |
| `POST /api/links` | `{label}` -> `{session_id, verify_url, expires_at}`. Admin only. |
| `GET /api/admin/stream?token=` | Server-Sent Events on session create, status change, and complete. |
| `GET /api/health` | Liveness. |

`/api/admin/stream` is the **only** endpoint that accepts the admin token as a query parameter, because
`EventSource` cannot set headers. The token is redacted from uvicorn's access log, but a proxy in front of the
service may still log the URL; rotate `ADMIN_TOKEN` after a demo.

### Plan and events

```json
{"challenges": [
   {"id": "c_1f0a9b2c", "kind": "head_sequence", "moves": ["left", "up", "right"]},
   {"id": "c_77d3e014", "kind": "cued_blink", "cue_offsets_ms": [2100, 5300, 7900]},
   {"id": "c_a04c55e1", "kind": "digits", "digits": "0427"}],
 "pulse_hold_ms": 12000}
```

Challenge order, moves, cue offsets, and digits come from Python's `secrets` module.

Event `type` is one of `challenge_start`, `cue`, `response`, `challenge_end`. The timing check reads two
payload fields: `index` (which cue a `cue` or `response` belongs to, starting at 0) and, for head moves,
`move`. `client_ts_ms` is the client's `Date.now()`.

When the visitor enables the microphone, the digits challenge's `challenge_end` payload also carries four numbers measured on the device: `peakCorr`, `lagMs`, `voicedFraction`, and `digitsMatched` (0-4). They are stored for the dashboard and are not used by the freshness check. Audio and the transcript are never sent; the payload rules above would reject them anyway.

### Freshness checks (`app/timing.py`)

| Finding | Class | Risk |
| --- | --- | --- |
| None | clean | 10 |
| A cued response outside 150-2500 ms; a response with no cue; no cue/response pairs; no events; unknown clock offset | soft | 50 |
| A latency under 120 ms ("anticipatory response"); three or more latencies with a standard deviation under 15 ms ("machine-regular timing"); head moves or challenges out of plan order; an event time outside the session window | hard | 85 |

Freshness is a **veto, not a weighted input**: a risk of 70 or more blocks `approve`. It is never part of the
five weighted signals, whose weights still sum to 100.

> **Current frontend limitation.** Until `lib/challenges.ts` consumes the plan directly, the web client maps
> the plan onto its existing challenges and reports only `challenge_start` / `challenge_end`. There are no
> cue/response latencies yet, so every real session currently shows "Freshness: flagged" with the soft
> finding "no cue/response pairs were reported". That is the honest result, not a bug.

### Policy parity

`app/policy.py` mirrors `lib/risk.ts`: same weights, thresholds, risk 60 for missing evidence, and reason
text. `tests/test_policy.py` feeds the four attack-lab fixtures from `lib/scenarios.ts` and asserts
7/approve, 73/reject, 31/step-up, and 67/reject, the same values as `tests/risk.test.ts`. Signal ids live in
one constant (`SIGNAL_IDS`), so a rename is one edit there plus the matching edit in `lib/`. Change both
files together and bump `POLICY_VERSION`.

## Data

`sessions`: id, created/expiry times, status, plan, `plan_consumed`, clock offset, decision, risk, coverage,
policy version, optional demo labels, a coarse browser/OS bucket such as `Chrome/Android` (the User-Agent
string itself is not stored), and `result_json` (scores, provenance, reason text). `events`: challenge id,
type, client and server timestamps, and a small flat payload. IP addresses are used in memory for rate
limiting and are not stored.

## Deploy

The container listens on `$PORT`. It must run as **one instance with one worker**: sqlite is a local file and
the SSE bus and rate limiter live in process memory. See step 11 of `../DEPLOYMENT.md` for Render, Railway, and
Cloud Run commands.

```sh
docker build -t aegis-api backend
docker run --rm -p 8000:8000 --env-file backend/.env aegis-api
```
