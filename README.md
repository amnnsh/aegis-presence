<div align="center">

# 🛡️ AEGIS PRESENCE

### Trust the person. Not just the pixels.

**A privacy-conscious, browser-based prototype exploring layered liveness checks and explainable video-verification risk.**

[![Live Demo](https://img.shields.io/badge/Live_Demo-Explore_Aegis-2563eb?style=for-the-badge)](https://aegis-presence-inky.vercel.app)
[![Next.js](https://img.shields.io/badge/Next.js-App_Router-black?style=for-the-badge&logo=nextdotjs)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

**[Try the demo](https://aegis-presence-inky.vercel.app)** · **[Explore attack lab](https://aegis-presence-inky.vercel.app/verify/?mode=lab)** · **[Deployment guide](DEPLOYMENT.md)**

</div>

> **Hackathon prototype — not a production identity-verification service.** Camera, liveness, spoken-digit, and lip / voice timing checks are experimental, untuned heuristics; the deepfake-artifact score is simulated. Live verification deliberately cannot approve a user.

## 🚨 The challenge

A convincing face on a screen is not proof that a real person is present. Replayed footage, virtual-camera feeds, and AI-generated video complicate remote verification. **Aegis Presence** explores a different question: *What evidence can a browser gather, and how clearly can it explain what remains uncertain?*

## ✨ What Aegis demonstrates

| Layer | Demo capability | Reality check |
| --- | --- | --- |
| 📷 Camera integrity | Reads the camera label, exposed controls and resolution range, and the first ~3 s of frame timing (cadence jitter, gaps, repeated identical frames) | Spoofable signals; not hardware attestation. A renamed virtual camera can still pass |
| 👁️ Active liveness | A random three-move head sequence (left / right / up / down, one arrow at a time), blinks that must answer randomly timed ring cues within 150-1500 ms, and a four-digit prompt. Prompts advance automatically, and cue / response timings are logged for the server. With the optional microphone, an on-device speech model (Whisper tiny) checks the spoken digits | Checks the words, not the speaker. Without the microphone it is mouth motion only. Does not certify liveness |
| 🌈 Screen-light response | Optional six-step color stimulus and cheek-color sampling | Experimental; affected by lighting, exposure, and movement |
| 💓 Pulse signal (rPPG) | Experimental on-device skin-color pulse estimate | Unvalidated; not proof of liveness or medical heart rate |
| 🔊 Audio-visual sync | With the optional microphone, correlates mouth opening with loudness during the digits prompt, on-device | Untuned correlation heuristic, **not** a lip-sync model. Unavailable (never simulated) without the microphone |
| ⚖️ Explainable risk | Weighted local score, provenance, missing-evidence handling | Illustrative policy, **not** a fraud probability |
| 🧪 Attack lab | Four fixed scenarios demonstrating approve / step-up / reject | Fictional fixtures, **not** measured detection results |

## 🎬 Experience the demo

1. **Open the [live app](https://aegis-presence-inky.vercel.app)** and review the overview.
2. **Try verification** at `/verify/`: grant camera permission if comfortable, then follow or skip randomized challenges.
3. **Review the result**: see available signals, missing evidence, and the reasoning behind the illustrative outcome.
4. **Explore the [attack lab](https://aegis-presence-inky.vercel.app/verify/?mode=lab)** without camera access.
5. **Visit `/admin/`** for a searchable dashboard of fictional attempts (not real users).

**Privacy first:** Camera inference runs locally in the browser. The microphone is requested only if you tick its separate consent box, and only for the spoken-digit prompt: audio is held in memory for at most 8 seconds, transcribed and compared with lip movement on your device by a self-hosted model, then discarded. No audio, transcript, image, or video is uploaded, and the Web Speech API (which can send audio to a cloud service) is deliberately not used. The application does not create user accounts or persist verification sessions in the browser. Hosting providers may still collect ordinary request logs.

## 🏗️ How it works

```mermaid
flowchart TD
    A[Open Aegis in browser] --> B{Choose experience}
    B -->|Live prototype| C[Explicit camera consent]
    B -->|Attack lab| L[Fixed fictional scenarios]
    C --> D[Camera metadata checks]
    C --> E[Local MediaPipe face landmarks]
    E --> F[Random gesture challenges]
    E --> G[Optional screen-light response]
    D --> H[Explainable local risk engine]
    F --> H
    G --> H
    I[Missing forensic evidence] --> H
    L --> H
    H --> J[Risk breakdown and decision]
```

The site is a **static Next.js application**. The model and MediaPipe WASM assets are prepared during setup and served from the same origin. Browser-generated risk values are not tamper-proof authorization decisions.

**Optional backend.** [`backend/`](backend/README.md) is a small FastAPI service. When the site is built with `NEXT_PUBLIC_API_URL`, each live session gets a fresh single-use challenge plan, reports event timing (numbers and short enums; never frames or audio), and receives a decision that the server recomputed and signed. The server checks the *consistency and freshness of reported events*. It does not see the camera and does not authenticate it, and the signal scores still originate in the browser. Without the variable, or when the API is unreachable, the app behaves exactly as before and labels the result **Local only - not server-checked**.

## 🧠 Risk scoring — transparent by design

Aegis combines five inputs using fixed weights:

| Signal | Weight |
| --- | ---: |
| Active liveness | 30% |
| Camera integrity | 20% |
| Pulse signal (rPPG) | 20% |
| Screen-light response | 15% |
| Audio-visual synchronization | 15% |

`risk = Σ(weight × usedRisk / 100)`

Missing, invalid, excluded, or duplicate evidence contributes **60/100 at its original weight**, rather than being ignored. Simulated forensic scores cannot improve a live decision.

In the **attack lab**, the illustrative policy uses these thresholds: **approve < 30**, **step-up 30 to < 65**, **reject ≥ 65**, subject to additional coverage and camera-risk conditions. In **live mode, approval is disabled**. A live rejection also requires multiple high-risk usable signals and sufficient evidence; otherwise the result is step-up.

> These weights and thresholds are design choices, not scientifically calibrated fraud probabilities.

## 🧪 Attack lab scenarios

| Scenario | Illustrative risk | Demo outcome |
| --- | ---: | --- |
| Normal user | 7/100 | Approve |
| Replayed video | 73/100 | Reject |
| Virtual-camera feed | 31/100 | Step-up |
| Deepfake sample | 67/100 | Reject |

All four are **deterministic fictional fixtures**. The lab does not analyze a real attack video or measure detection accuracy.

## 🛠️ Built with

- **Next.js + React + TypeScript** — responsive interface and client-side experience
- **MediaPipe Face Landmarker** — local facial landmarks and expression signals
- **Browser Camera API** — permission-based webcam capture
- **Playwright** — browser workflow testing
- **Vercel** — static deployment

## 🚀 Run locally

**Prerequisites:** Node.js **24 LTS**, npm, and a current desktop Chrome browser for the first webcam test. Other browsers and mobile devices need separate verification.

```bash
git clone https://github.com/amnnsh/aegis-presence.git
cd aegis-presence
npm install
npm run dev
```

Open **http://localhost:3000**.

The install process prepares MediaPipe WASM, downloads a versioned face-landmark model, and downloads a pinned, checksum-verified speech model (about 43 MB) plus the ONNX runtime into `public/`. Set `AEGIS_SKIP_SPEECH_MODEL=1` to skip the speech model; spoken digits then fall back to mouth motion only. If asset preparation warns or fails, retry with:

```bash
npm run assets
```

On Windows PowerShell, if `npm.ps1` is blocked by execution policy, run `npm.cmd install` and `npm.cmd run dev` instead.

**Useful checks:**

```bash
npm run typecheck
npm test
npm run build
npm run start
```

**Head-pose sign check:** open **http://localhost:3000/verify/?debug=1**, start the webcam, and watch the yellow readout on the preview. Turning to your own left should read `user's LEFT` (positive yaw), and looking up should read `user's UP` (negative pitch). If either is reversed on some device, flip its sign in `MOVE_AXIS` in `lib/head-pose.ts`; the arrows, tracker, and readout all use that one table.

`npm run start` previews the static production export at `http://localhost:3000`; stop the development server first. For browser tests after a successful build:

```bash
npx playwright install chromium
npm run test:browser
```

**Optional backend** (Python 3.11+), in a second terminal:

```bash
cd backend
python -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
cp .env.example .env                            # set ADMIN_TOKEN and SIGNING_KEY_B64
uvicorn app.main:create_app --factory --env-file .env --port 8000
pytest
```

Then start the site with `NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev` (PowerShell: `$env:NEXT_PUBLIC_API_URL = "http://localhost:8000"; npm.cmd run dev`). Details: **[backend/README.md](backend/README.md)**.

For deployment, authentication, troubleshooting, and release checks, see **[DEPLOYMENT.md](DEPLOYMENT.md)** and **[docs/QA_REPORT.md](docs/QA_REPORT.md)**. Do not claim that tests passed until they run successfully in your environment.

## 🗂️ Repository guide

```text
app/                    Next.js routes and styles
components/             Verification UI, results, dashboard
lib/vision.ts           Local camera/model lifecycle
lib/challenges.ts       Random prompts and gesture logic
lib/injection.ts        Camera metadata and frame-timing heuristics
lib/reflection.ts       Optional color-response experiment
lib/risk.ts             Weighted policy and missing evidence
lib/scenarios.ts        Simulated attack fixtures
lib/audio.ts            Optional microphone capture (AudioWorklet), in memory only
lib/speech.ts           Digits prompt: recording, on-device transcription, fallback
lib/asr.worker.ts       Whisper tiny in a Web Worker (Transformers.js), self-hosted
lib/digits.ts           Transcript-to-digits normalization and matching
lib/sync.ts             Lip / voice timing correlation
lib/api.ts              Optional backend client, local-only fallback
backend/                FastAPI service: plans, timing checks, signed results
tests/                  Unit and browser tests
scripts/                Assets and static preview
DEPLOYMENT.md           Deployment walkthrough
docs/DEMO_SCRIPT.md     Two-minute presentation
docs/PITCH.md           Project pitch
docs/QA_REPORT.md       Test evidence and release gaps
```

## 🔐 Responsible design and limitations

- **No identity assertion:** Matching an enrolled person's identity is outside this prototype.
- **No production security boundary:** Client-side code and scores can be modified by an attacker.
- **No validated spoof-detection performance:** Camera, gesture, and color heuristics share limitations and may fail on legitimate users.
- **No real forensic models:** The deepfake-artifact value is a demonstration only. Lip / voice timing is a simple correlation with thresholds that have **not** been tuned or measured on recordings (see the QA report); the spoken-digit check verifies words, not who said them, and a replayed or synthesized voice reading the right digits passes it.
- **No real admin telemetry:** Dashboard records are fictional; live sessions are not saved there.
- **Accessible alternatives matter:** Challenges can be skipped; skipping adds uncertainty rather than silently passing or proving fraud.

## 🗺️ Roadmap

- [ ] Evaluate real deepfake-detection models on documented datasets
- [ ] Validate false-accept and false-reject rates across devices and conditions
- [ ] Add secure server-issued, expiring challenges and replay protection
- [ ] Build accessible step-up and human-review workflows
- [ ] Test camera performance on real phones and multiple browsers
- [ ] Develop a deliberate privacy, retention, and threat-modeling plan

## 📚 Documentation and references

**Project documents:** [Deployment](DEPLOYMENT.md) · [Demo script](docs/DEMO_SCRIPT.md) · [Pitch](docs/PITCH.md) · [Build plan](docs/BUILD_PLAN_24H.md) · [QA report](docs/QA_REPORT.md) · [Third-party notices](THIRD_PARTY.md)

**Technical references:** [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js) · [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) · [Next.js](https://nextjs.org/docs/app/getting-started/installation)

**Context sources:** [Entrust identity fraud report announcement (2025)](https://www.entrust.com/company/newsroom/deepfakes-social-engineering-and-injection-attacks-on-the-rise) · [Pindrop enterprise survey (2026)](https://www.pindrop.com/company-news/deepfakes-are-hitting-the-enterprise-but-90-lack-purpose-built-defenses) · [Gartner forecast (2024)](https://www.gartner.com/en/newsroom/press-releases/2024-02-01-gartner-predicts-30-percent-of-enterprises-will-consider-identity-verification-and-authentication-solutions-unreliable-in-isolation-due-to-deepfakes-by-2026)

## 🤝 Contributors and license

Built as a hackathon prototype. See the repository's commit history for contributors and attribution. Project code is MIT-licensed; third-party libraries and model assets have their own terms. Review [THIRD_PARTY.md](THIRD_PARTY.md) before redistribution.

<div align="center">

### 🛡️ AEGIS PRESENCE
**Trust the person. Not just the pixels.**

[Back to top](#️-aegis-presence)

</div>

### Experimental pulse stage

After gestures, the browser offers a 12-second on-device rPPG stage with a skip option, a waveform and an estimated BPM. The estimate comes from forehead and cheek RGB means; raw frames are not retained. Signal quality and risk thresholds are exploratory and **not** evidence of genuine presence or medical pulse accuracy. Team validation with real cameras and replay attacks is pending.
