# Aegis QA record

Date: **October 5, 2026**. This record separates executed checks from proposed or supplied tests. It is not a security assessment, model evaluation, production-readiness claim, or proof that every dependency installs successfully.

## Executed successfully

**Core behavior:** `npm test` ran with Node **22.16.0** and npm **10.9.2**, without installing external packages. All **29 tests passed**, with zero failures or skips. Tests cover deterministic fixture results, fixed-weight risk math, missing/invalid/duplicate inputs, live exclusion of simulated inputs, live approval prevention, unrounded threshold boundaries, gesture sequencing, random prompt properties, camera metadata hints, reflection correlation, and weak/incomplete reflection response.

**Strict pure-TypeScript check:** global TypeScript successfully checked `lib/types.ts`, `lib/risk.ts`, `lib/injection.ts`, `lib/challenges.ts`, `lib/reflection.ts`, and `lib/scenarios.ts` with `--strict`, ES2022/DOM libraries, bundler resolution, and no emit. This is not the full dependency-aware `npm run typecheck`.

**Source-component browser interaction:** the actual component/core source was transpiled into an isolated local rendering harness and exercised through Python Playwright and the available headless Chromium. The harness used preinstalled **React 16.0.0 / ReactDOM 16.0.1**, rather than the requested package versions. Class components and stateless functions were rendered directly. It did **not** run Next.js, the App Router, React 19, production hydration, downloaded MediaPipe, or a real webcam. Browser page content was supplied directly; the environment's managed navigation restrictions were not disabled.

The executed interaction assertions passed:

- Four fixture outcomes: 7/approve, 73/reject, 31/step-up, 67/reject, each with five simulated provenance badges.
- Webcam button requires consent; Continue without camera returns step-up with risk 60.
- Mock dashboard Reject filter returns four rows; ID search and evidence inspection work.
- Landing, verification, and dashboard layouts at 360, 390, 768, and 1440 pixels have no unintended page-wide horizontal overflow; the admin table scrolls inside its container.
- No browser page exceptions during those interactions. Desktop/mobile source-component screenshots were visually inspected.

All 23 TypeScript/TSX source, configuration, and test files also passed syntax/transpile checks. The three Node helper scripts passed `node --check`. Relative Markdown links were checked for existing targets. These checks do not resolve external package types.

## Could not be executed here

Outbound dependency/model downloads from the authoring container failed. In addition, the installed Chromium's managed policy blocked ordinary URL navigation, including localhost. No attempt was made to bypass that policy. Consequently, these remain **unverified release gates**:

1. `npm install` / `npm ci`, the generated dependency lockfile, dependency audit, and a full `npm run typecheck` using installed package types.
2. `npm run assets`, successful official model/WASM delivery, complete `npm run build`, and actual Next.js/React 19 runtime behavior.
3. The supplied real-export Playwright suite (`tests/browser.spec.ts`), production CSP/WASM compatibility, and the GitHub Actions workflow. These files are provided but must be run on the team's machine/CI.
4. Physical webcam consent, frame-cadence measurement, MediaPipe landmark accuracy, head-direction behavior, blink/word-mouth heuristics, color response, and hardware cleanup in target browsers.
5. Physical Android/iPhone behavior, Safari/Firefox support, accessibility review with assistive technology, and low-end device latency.
6. GitHub authentication/collaboration, Vercel build/deployment, production/preview integrations, plan eligibility, and public judge access. No live URL or repo has been provisioned.

## Required team sign-off

Use the steps in `DEPLOYMENT.md`. Record the actual OS/browser/device and release commit, pass `npm run check`, then run `npx playwright install chromium` and `npm run test:browser`. The supplied suite defines five checks for each of two Chromium projects (desktop and mobile emulation). A green automated run does not replace a physical camera and phone rehearsal.

Manually test allow, deny, no camera, busy camera, blocked model, multiple faces, no face, skipped/expired challenge, optional-light skip, hidden-tab cancellation, navigation during an unresolved permission prompt, and camera closure after the result. Refresh should remove live session results, and the admin should remain fictional. Inspect network/storage behavior and production security headers.

## Spoken digits and lip / voice timing (added October 13, 2026)

### Executed

- `npm run check` passed: type-check, 56 unit tests, and the static build. The new tests cover the correlation (`tests/sync.test.ts`), transcript handling (`tests/digits.test.ts`), and the changed liveness / policy behavior.
- The built export was driven in headless Chrome on Windows 11 with the production headers from `vercel.json`. The camera was a blank canvas stream (no face) and the microphone was a stand-in stream playing Windows text-to-speech digit words. This exercises the worklet, the speech worker, the self-hosted model, and the UI. It is **not** a human test.

| Scenario (synthetic voice, no face) | Runs | Result |
| --- | --- | --- |
| Voice reads the prompted digits | 3 | "Heard" matched 4/4 in all 3 (prompts 3671, 9149, 2292) |
| Voice reads four different digits | 1 | 0/4 matched, liveness risk raised |
| Silence | 1 | "No digits were heard", digits unavailable, recording stopped at the 8 s cap |
| Microphone box unchecked | 1 | Microphone never requested; digits mouth-only; sync unavailable |
| Speech model requests blocked | 1 | Fallback message shown; digits not verified; nothing simulated |

In every run the microphone track ended when the digits prompt ended, the page made no request outside its own origin, and the sync signal was "unavailable" because there was no face to measure. An earlier run with a 0.9 s end-of-speech pause cut one prompt short ("Heard: 2 6" of 2605); the pause was raised to 1.5 s.

### NOT executed: the acceptance runs

Nobody has yet run this with a real face and a real voice, so **lip / voice timing has never produced a measured value**, and the thresholds in `lib/sync.ts` (peak correlation 0.5 / 0.3, lag within 200 ms, voiced fraction 0.1) are untested starting points. Do not quote them as tuned. Fill in the table below on the presentation laptop; the numbers appear in the Audio-visual sync row of the result view.

Device: ____  Browser and version: ____  Microphone: ____  Room: ____  Date: ____

| Run | Condition | Heard / prompted | Digits matched | Peak correlation | Lag (ms) | Voiced % | Sync risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Reads digits normally | | | | | | |
| 2 | Reads digits normally | | | | | | |
| 3 | Reads digits normally | | | | | | |
| 4 | Reads digits normally | | | | | | |
| 5 | Reads digits normally | | | | | | |
| 6 | Mouths silently while another person reads aloud | | | | | | |
| 7 | Plays a recording of different digits | | | | | | |

Expected if the starting thresholds hold: runs 1 to 5 mostly give sync risk 15 to 40; run 6 gives a high sync risk; run 7 fails the digit match. If the measured lag sits at a steady offset (camera and microphone latency are not compensated) or genuine readings land below 0.3, change the constants in `SYNC` and record the before and after numbers here.

Known limits to keep in the pitch: the digit check verifies words, not the speaker, so a cloned or replayed voice saying the right digits passes it; the timing check is a loudness / mouth-opening correlation that a face animated from the same audio would also pass; background speech, a covered mouth, or poor light can fail a genuine user.

## Security/evaluation status

No labeled deepfake benchmark, anti-spoofing certification, penetration test, demographic evaluation, calibrated probability, independence proof, or accessibility certification was performed. All fixture risks and policy weights are illustrative. A high-risk live heuristic is not proof of fraud. A low-risk synthetic fixture is not proof of a person's identity. The frontend is client-tamperable and must not authorize access.
