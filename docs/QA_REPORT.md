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

## Full-screen light check (added October 17, 2026)

The light-response check now fills the whole viewport with saturated red / green / blue plateaus (1.5 s each, 250 ms crossfade, six steps, no color twice in a row). Before the plateaus start it asks the camera to hold exposure and white balance where the camera supports it. It samples 12x12 patches on the forehead and both cheeks, 500 ms after each color appears. Before this change the color only lit a 14 px border with pastels, so the check almost always returned "too weak to measure".

### Executed

- `npm run check` passed: type-check, unit tests, and the static build. `tests/reflection.test.ts` covers the color sequence (500 draws: six steps, each color twice, no adjacent repeats), the 4.5:1 text contrast of the black panels on every stimulus, the forehead / cheek patch selection, the correlation on synthetic tinted skin, and camera locking against fake tracks (supported keys only, settings read back, restore to continuous, no calls on an ended track).
- `tests/light.browser.spec.ts` drove the built export in headless Chromium (desktop and Pixel 7 emulation) with Chromium's synthetic camera and an emulated webcam that reports manual exposure / white balance. Both runs passed. The overlay covered the full viewport, and the colors changed with a 0.25 s transition (0 s under reduced motion). The covered main `<video>` and the mirrored thumbnail both kept playing. Skip took focus and Tab could not leave the dialog, and Escape skipped the check. The camera received `manual` before the plateaus and `continuous` before the track stopped. The result reported "Exposure and white balance locked."
- The synthetic camera has no face, so **no correlation was measured**. These runs prove the plumbing, not the physics.

### NOT executed: threshold tuning and the acceptance runs

The correlation cut-offs in `lib/reflection.ts` (`REFLECTION`: 0.4 for risk 25, 0.15 for risk 50, chroma RMS 0.003 for "too weak") are **unchanged, untuned starting points**. Tuning needs the team's own recordings, which do not exist yet. The Light response row of the result view shows the correlation, the chroma RMS, and whether the camera was locked. Copy those three values from each run.

Device: ____  Browser and version: ____  Camera: ____  Screen brightness: ____  Room light: ____  Date: ____

| Run | Condition | Camera lock reported | Correlation | Chroma RMS | Light risk |
| --- | --- | --- | --- | --- | --- |
| R1 | Real person, laptop, normal room light | | | | |
| R2 | Real person, laptop, normal room light | | | | |
| R3 | Real person, laptop, normal room light | | | | |
| R4 | Real person, laptop, normal room light | | | | |
| R5 | Real person, laptop, normal room light | | | | |
| R6 | Real person, dimmer room | | | | |
| R7 | Real person, dimmer room | | | | |
| R8 | Real person, different skin tone | | | | |
| R9 | Real person, different skin tone | | | | |
| R10 | Real person, glasses | | | | |
| P1 | Phone screen replaying a recorded face, held to the webcam | | | | |
| P2 | Phone screen replay | | | | |
| P3 | Phone screen replay | | | | |
| P4 | Phone screen replay | | | | |
| P5 | Phone screen replay | | | | |
| P6 | Phone screen replay, phone brightness at maximum | | | | |
| P7 | Phone screen replay, phone brightness at maximum | | | | |
| P8 | Phone screen replay, tilted to catch the laptop's light | | | | |
| P9 | Phone screen replay, tilted to catch the laptop's light | | | | |
| P10 | Phone screen replay, second phone | | | | |

**Acceptance:** at least 4 of R1 to R5 show a measured correlation, not "too weak", and the P runs are clearly lower than the R runs. If they are, set `REFLECTION.strong` just below the lowest R correlation and `REFLECTION.weak` just above the highest P correlation. Record the before and after values here and update the threshold test in `tests/reflection.test.ts`. If the ranges overlap, keep the check as a weak signal and say so in the pitch. If most R runs are still "too weak", note whether "Camera lock reported" said "Auto exposure"; many built-in laptop cameras do not expose manual modes to the browser.

Known limits: a replay screen can also pick up some of the laptop's colored light, so this separates poorly lit replays, not careful ones. The camera is restored to automatic when the session ends, but a tab killed mid-check cannot run that restore.

## Camera integrity beyond the device label (added October 17, 2026)

`inspectCamera` used to score mostly a regex on the camera label, so a renamed virtual camera passed clean. It now also uses the controls the camera exposes, its resolution range, the number of video inputs (a count only), and the first ~3 s of frame timing. Frame timing means the spread of frame intervals, the largest gap, and how often consecutive 16x12 grayscale thumbnails are identical. The label flag dropped from +62 to +35. All of it stays "heuristic": a determined attacker can fake every one of these values.

| Flag | Added risk | Fires when |
| --- | --- | --- |
| Virtual-camera-like label | +35 | Label matches obs, virtual, manycam, xsplit, snap camera, droidcam, or ndi |
| No controls and one fixed resolution | +25 | No exposure, focus, or white-balance control, and width and height ranges with min = max |
| Machine-perfect cadence | +20 | Frame interval spread under 0.2 ms over at least 60 frames |
| Repeated frames | +25 | More than 20% of consecutive frames identical, over at least 20 frames |
| Frame gap | +10 | Any gap over 500 ms |

### Executed

- `npm run check` passed. `tests/injection.test.ts` covers each flag at its boundary, the lower label weight, the 95 cap, a clean laptop camera that stays at 8, and a renamed virtual camera that reaches 78 with no label flag. It also covers the capability summary (device and group IDs are never copied), the thumbnail hash, and the frame statistics.
- `tests/camera.browser.spec.ts` drove the built export in headless Chromium with a generated video file as the camera. In the file, the picture changes every second frame. The browser measured the repeats and the result showed the repeated-frames flag.
- Chromium's own synthetic devices, measured in the same headless setup on Linux:

| Device | Label | Controls / resolution | Frame timing | Flags | Risk |
| --- | --- | --- | --- | --- | --- |
| Chromium synthetic camera | fake_device_0 | Exposure, focus; up to 3840x2160 | 6.5 ms jitter, 0% repeated, 100 ms max gap | none | 8 |
| Chromium file feed, each frame shown twice | (file path) | None exposed; up to 320x240 | 14.7 ms jitter, 38% repeated, 67 ms max gap | repeated frames | 33 |

### Known gap: the fixed-resolution flag rarely fires in Chrome

Chrome can rescale camera frames, so it reports every camera's width and height minimum as 1 (`resizeMode: crop-and-scale`). That hides whether the device has one fixed mode. Both synthetic devices above reported min 1. So **"no controls and one fixed resolution" will almost never fire in Chrome**, including for OBS. It can fire in browsers that report real ranges. Do not remove the AND condition without data: some built-in cameras, especially on macOS, may expose no controls at all. If the table below shows that built-in cameras always expose controls and OBS never does, scoring "no controls" alone becomes reasonable.

### NOT executed: the acceptance runs

No real webcam or virtual camera was available here. Fill this in on the team laptops. The values appear in the "Observed camera metadata" panel and in the Camera integrity row of the result. For OBS, play a recorded face through OBS Virtual Camera, then repeat with the label hidden. On Linux, use v4l2loopback with `card_label="Integrated Webcam"`; on Windows, rename the device if possible.

Browser and version: ____  Date: ____

| Laptop / OS | Device | Label shown | Controls / resolution | Frame timing | Flags | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| | Built-in camera | | | | | |
| | Built-in camera | | | | | |
| | Built-in camera | | | | | |
| | OBS Virtual Camera playing a video | | | | | |
| | OBS Virtual Camera playing a video, label hidden or renamed | | | | | |
| | OBS Virtual Camera showing a still image | | | | | |

**Acceptance:** every built-in camera stays low (8 to 18), and OBS playing a video scores clearly higher even with its label hidden. If OBS with a hidden label only reaches 8, record which values matched a real camera. Likely culprits are the jitter and the repeated-frame ratio. Then adjust `CAMERA_FLAGS` in `lib/injection.ts` and its tests.

## Live dashboard and presenter labels (added October 17, 2026)

`/admin/` now reads the verification server when `NEXT_PUBLIC_API_URL` is set. The operator types the admin token, which is kept in that tab's `sessionStorage` and never bundled. The page loads recent sessions, streams new and changed ones over Server-Sent Events, and builds the KPI cards and a "Team test sessions" table from `GET /api/admin/summary`. That table counts only sessions with a presenter label and a decision, so each row adds up. Unlabeled visitor sessions and undecided sessions are listed in a footnote, not counted. Labels are chosen on `/verify/?demo=1` and never used for scoring. With no server configured, or the server unreachable, the page falls back to the labeled mock fixtures.

### Executed

- `npm run check` passed, including `tests/dashboard.test.ts`: results table, KPIs, row merging, stream parsing, the per-challenge timing summary, and token storage when storage is blocked. The backend suite passed unchanged (58 tests).
- **Acceptance run** on Linux with the real backend (`uvicorn`, local SQLite) and a production build pointed at it. Headless Chromium used its synthetic camera, so every challenge was skipped and no face was measured. The admin page was open and connected in a second tab:

| Presenter label | Row on /admin/ | Decision on /admin/ after the result page | Risk / decision / coverage |
| --- | --- | --- | --- |
| genuine | Already present when the challenges began (created at session start) | 2 ms | 50 / Step-up / 20 |
| phone replay | Already present | 2 ms | 50 / Step-up / 20 |
| virtual camera | Already present | 1 ms | 50 / Step-up / 20 |

  The results card showed n = 3, one Step-up per label, and the KPI cards showed 3 sessions and 3 step-ups. Clicking a row opened the compact result view with its timing table. Reloading the page reconnected from the stored token. With the backend stopped, a reload showed "The verification server is unreachable, so sample data is shown." Sample data was on, and the mock flow worked: 4 Reject rows, inspector opens.
- These three sessions prove the plumbing, not detection: no real person or attack was presented.

### NOT executed

- The team's own labeled sessions with real people and real attacks. Use `/verify/?demo=1`, pick the label before enabling the webcam, and read the counts from "Team test sessions". Keep its subheading: it is a small sample on our own devices, not a benchmark.
- A deployed run. `vercel.json` still has the placeholder API origin `https://aegis-api.example.com` in `connect-src`. Replace it with the real API origin before deploying (DEPLOYMENT.md, step 11).

## Security/evaluation status

No labeled deepfake benchmark, anti-spoofing certification, penetration test, demographic evaluation, calibrated probability, independence proof, or accessibility certification was performed. All fixture risks and policy weights are illustrative. A high-risk live heuristic is not proof of fraud. A low-risk synthetic fixture is not proof of a person's identity. The frontend is client-tamperable and must not authorize access.
