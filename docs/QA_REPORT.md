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

## Security/evaluation status

No labeled deepfake benchmark, anti-spoofing certification, penetration test, demographic evaluation, calibrated probability, independence proof, or accessibility certification was performed. All fixture risks and policy weights are illustrative. A high-risk live heuristic is not proof of fraud. A low-risk synthetic fixture is not proof of a person's identity. The frontend is client-tamperable and must not authorize access.
