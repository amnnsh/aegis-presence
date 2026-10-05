"use client";
import * as React from "react";
import { BrowserVision, cameraError } from "../lib/vision.ts";
import { createChallenges, GestureTracker, challengeTitle, challengeHint, livenessSignal } from "../lib/challenges.ts";
import { inspectCamera } from "../lib/injection.ts";
import { evaluateRisk, SIGNALS } from "../lib/risk.ts";
import { SCENARIOS, scenarioResult } from "../lib/scenarios.ts";
import { COLOR_HOLD_MS, lightSequence, readCheekColor, reflectionSignal } from "../lib/reflection.ts";
import type { ColorSample, Stimulus } from "../lib/reflection.ts";
import type { Challenge, ChallengeResult, DecisionResult, DeviceEvidence, FaceMetrics, ScenarioId, Signal } from "../lib/types.ts";
import { Header, Footer, Icon, SourceBadge, PrivacyNote, PrototypeNotice, ResultView, signalIcons } from "./ui.tsx";

type Stage = "setup" | "preparing" | "ready" | "challenge" | "between" | "reflection" | "result";
interface State {
  stage: Stage; tab: "live" | "lab"; consent: boolean; lightConsent: boolean;
  scenario: ScenarioId; sessionId: string; challenges: Challenge[]; challengeIndex: number;
  results: ChallengeResult[]; secondsLeft: number; hint: string; faceCount: number | null;
  device: DeviceEvidence | null; model: "idle" | "loading" | "ready" | "unavailable";
  modelError: string; error: string; result: DecisionResult | null; lightStep: number; colors: Stimulus[];
}
function initialState(): State {
  return { stage: "setup", tab: "live", consent: false, lightConsent: false, scenario: "normal", sessionId: "",
    challenges: [], challengeIndex: 0, results: [], secondsLeft: 25, hint: "", faceCount: null,
    device: null, model: "idle", modelError: "", error: "", result: null, lightStep: 0, colors: [] };
}
const noReflection = (detail = "Screen-color check was not performed. Skipping is supported and never counts as a pass."): Signal => ({ id: "reflection", risk: null, provenance: "unavailable", detail });

export class Verification extends React.Component<Record<string, never>, State> {
  state = initialState();
  private video: HTMLVideoElement | null = null;
  private overlay: HTMLCanvasElement | null = null;
  private samplesCanvas: HTMLCanvasElement | null = null;
  private engine: BrowserVision | null = null;
  private tracker: GestureTracker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private mounted = false;
  private deadline = 0;
  private lightStarted = 0;
  private samples: ColorSample[] = [];
  componentDidMount() {
    this.mounted = true;
    if (new URLSearchParams(window.location.search).get("mode") === "lab") this.setState({ tab: "lab" });
  }
  componentWillUnmount() { this.mounted = false; this.release(); }
  private clearTimer() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private release() {
    this.generation++; this.clearTimer(); this.tracker = null;
    this.engine?.stop(); this.engine = null; this.samples = [];
    if (this.samplesCanvas) { this.samplesCanvas.width = 0; this.samplesCanvas.height = 0; this.samplesCanvas = null; }
    if (this.overlay) this.overlay.getContext("2d")?.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
  private reset = () => { this.release(); this.setState(initialState()); };
  private cancel = () => {
    this.release();
    this.setState({ ...initialState(), consent: this.state.consent, error: "Session cancelled. Camera stopped and evidence discarded." });
  };
  private startCamera = () => {
    if (!this.state.consent || this.state.stage !== "setup") return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.setState({ error: "Camera access requires HTTPS or localhost in a supported browser. Open this site directly, or continue without camera for a step-up result." });
      return;
    }
    this.release();
    const generation = this.generation;
    const current = () => this.mounted && generation === this.generation;
    const challenges = createChallenges();
    this.setState({ stage: "preparing", challenges, challengeIndex: 0, results: [], error: "", modelError: "", model: "idle", faceCount: null, device: null, sessionId: `LIVE-${crypto.randomUUID().slice(0, 8).toUpperCase()}` }, () => {
      if (!this.video || !current()) return;
      document.querySelector(".verification-main")?.scrollIntoView({ block: "start", behavior: "instant" });
      this.samplesCanvas = document.createElement("canvas");
      const engine = new BrowserVision({
        device: d => { if (current()) this.setState({ device: d }); },
        metrics: m => { if (current()) this.onMetrics(m); },
        model: (model, message) => { if (current()) this.setState({ model, modelError: message || "" }); },
        interrupted: message => {
          if (!current()) return;
          this.release(); this.setState({ ...initialState(), error: message });
        },
      });
      this.engine = engine;
      engine.start(this.video).then(() => { if (current()) this.setState({ stage: "ready" }); }).catch(error => {
        if (!current()) return;
        this.release(); this.setState({ stage: "setup", device: null, model: "idle", error: cameraError(error) });
      });
    });
  };
  private onMetrics(m: FaceMetrics) {
    if (this.state.faceCount !== m.faceCount) this.setState({ faceCount: m.faceCount });
    if (this.overlay && this.video) {
      this.overlay.width = this.video.videoWidth || 640; this.overlay.height = this.video.videoHeight || 480;
      const ctx = this.overlay.getContext("2d");
      if (ctx && m.faceCount === 1) {
        ctx.fillStyle = "#a5efcf";
        for (const i of [1, 4, 33, 61, 93, 127, 133, 152, 172, 199, 234, 263, 291, 323, 356, 362, 397, 454]) {
          const point = m.points[i]; if (!point) continue;
          ctx.beginPath(); ctx.arc(point.x * this.overlay.width, point.y * this.overlay.height, 2.3, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    if (this.state.stage === "challenge" && this.tracker) {
      const result = this.tracker.update(m);
      if (result) { this.completeChallenge(result); return; }
      const hint = m.faceCount === 0 ? "No face detected. Center your face in the light." : m.faceCount > 1 ? "More than one face. Only one person should be visible." : this.tracker.progress;
      if (hint !== this.state.hint) this.setState({ hint });
    }
    if (this.state.stage === "reflection" && m.faceCount === 1 && Math.abs(m.yaw) < 0.2 && this.video && this.samplesCanvas) {
      const elapsed = performance.now() - this.lightStarted;
      const step = Math.floor(elapsed / COLOR_HOLD_MS);
      const stimulus = this.state.colors[step];
      if (stimulus && elapsed % COLOR_HOLD_MS > 900 && this.samples.filter(s => s.step === step).length < 8) {
        const observed = readCheekColor(this.video, m.points, this.samplesCanvas);
        if (observed) this.samples.push({ step, expected: stimulus.rgb, observed });
      }
    }
  }
  private startChallenge = (index = 0) => {
    const challenge = this.state.challenges[index]; if (!challenge) return;
    this.clearTimer(); this.tracker = new GestureTracker(challenge);
    this.deadline = performance.now() + 25000;
    this.setState({ stage: "challenge", challengeIndex: index, secondsLeft: 25, hint: this.tracker.progress });
    this.timer = setInterval(() => {
      const seconds = Math.max(0, Math.ceil((this.deadline - performance.now()) / 1000));
      if (seconds !== this.state.secondsLeft) this.setState({ secondsLeft: seconds });
      if (seconds === 0 && this.tracker) this.completeChallenge(this.tracker.unavailable());
    }, 200);
  };
  private completeChallenge(result: ChallengeResult) {
    if (this.state.stage !== "challenge" || !this.tracker) return;
    this.tracker = null; this.clearTimer();
    this.setState(state => ({ stage: "between", results: [...state.results, result] }));
  }
  private skipChallenge = () => { if (this.tracker) this.completeChallenge(this.tracker.unavailable()); };
  private nextChallenge = () => {
    if (this.state.challengeIndex < 2) this.startChallenge(this.state.challengeIndex + 1);
    else this.beginReflection();
  };
  private beginReflection() {
    if (!this.state.lightConsent || this.state.model !== "ready") { this.finishLive(noReflection()); return; }
    this.clearTimer(); this.samples = [];
    const colors = lightSequence(); this.lightStarted = performance.now();
    this.setState({ stage: "reflection", colors, lightStep: 0 });
    this.timer = setInterval(() => {
      const step = Math.floor((performance.now() - this.lightStarted) / COLOR_HOLD_MS);
      if (step >= colors.length) { this.finishLive(reflectionSignal(this.samples)); return; }
      if (step !== this.state.lightStep) this.setState({ lightStep: step });
    }, 100);
  }
  private finishLive = (reflection = noReflection()) => {
    // SIMULATED: illustrative values only. evaluateRisk excludes these from LIVE decisions.
    const signals: Signal[] = [inspectCamera(this.state.device), livenessSignal(this.state.results), reflection,
      { id: "artifacts", risk: 18, provenance: "simulated", detail: "Simulated, real model in the full build. No deepfake model was run. This example value is excluded from the live risk calculation." },
      { id: "sync", risk: 22, provenance: "simulated", detail: "Simulated, real model in the full build. No microphone, audio recording, digit transcription, or synchronization analysis was performed. Excluded from live risk." },
    ];
    const result = evaluateRisk(signals, "live");
    this.release(); this.setState({ stage: "result", result, faceCount: null });
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  private runSimulation = (id = this.state.scenario) => {
    this.release();
    this.setState({ ...initialState(), tab: "lab", scenario: id, stage: "result", result: scenarioResult(id), sessionId: `FIXTURE / ${SCENARIOS.find(s => s.id === id)!.title}` });
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  private renderPrompt() {
    const s = this.state;
    if (s.stage === "setup") return <div className="prompt-card"><span className="eyebrow">BEFORE YOU BEGIN</span><h2>Your camera. Your control.</h2><p>Use a well-lit space and keep your face visible. The camera starts only after your permission. You can stop or skip a challenge at any time.</p><label className="consent"><input type="checkbox" checked={s.consent} onChange={e => this.setState({ consent: e.target.checked })} /><span>I agree to temporary, on-device webcam processing for this demo. Nothing is recorded or uploaded.</span></label><label className="consent light-consent"><input type="checkbox" checked={s.lightConsent} onChange={e => this.setState({ lightConsent: e.target.checked })} /><span>Also enable the optional slow screen-color check.<small>Changing colors may cause discomfort. Leave this off for photosensitivity; skipping routes to step-up.</small></span></label><div className="prompt-actions"><button className="button button-primary" disabled={!s.consent} onClick={this.startCamera}><Icon name="camera" size={18} />Enable webcam</button><button className="button button-text" onClick={() => this.finishLive()}>Continue without camera</button></div></div>;
    if (s.stage === "preparing") return <div className="prompt-card"><span className="eyebrow">STARTING LOCALLY</span><h2>{s.device ? "Loading face landmarks" : "Waiting for camera permission"}</h2><p>{s.device ? "The model and WASM load from this site's own origin. No frames leave your browser." : "Choose Allow in your browser's camera prompt. A denied or unanswered request never becomes a pass."}</p><button className="button button-secondary" onClick={this.cancel}>Cancel and stop camera</button></div>;
    if (s.stage === "ready") return <div className="prompt-card"><span className="eyebrow">{s.model === "ready" ? "CAMERA READY" : "LIMITED EVIDENCE"}</span><h2>{s.model === "ready" ? "A new challenge, every session." : "Landmarks are unavailable."}</h2><p>{s.model === "ready" ? "Follow three randomly ordered prompts. Head motion and blinks are local heuristics; reading digits is only a mouth-motion demonstration." : "You can see a conservative result with the missing checks marked unavailable. Nothing is silently simulated."}</p><div className="prompt-actions"><button className="button button-primary" onClick={s.model === "ready" ? () => this.startChallenge() : () => this.finishLive()}>{s.model === "ready" ? "Begin live challenges" : "Get step-up result"}<Icon name="arrow" size={18} /></button><button className="button button-text" onClick={this.cancel}>Stop camera</button></div></div>;
    if (s.stage === "challenge") { const c = s.challenges[s.challengeIndex]; return <div className="prompt-card active-prompt"><div className="prompt-heading"><span className="eyebrow">CHALLENGE {s.challengeIndex + 1} OF 3</span><span className="countdown mono">{s.secondsLeft}s remaining</span></div><h2>{challengeTitle(c)}</h2><p>{challengeHint(c)}</p><div className="challenge-feedback" role="status"><span className={`dot ${s.faceCount === 1 ? "" : "dot-amber"}`} />{s.hint}</div><div className="prompt-actions"><button className="button button-secondary" onClick={this.skipChallenge}>Skip this challenge</button><button className="button button-text" onClick={this.cancel}>Cancel session</button></div><p className="microcopy">A skip or timeout means missing evidence, not fraud and not a pass.</p></div>; }
    if (s.stage === "between") { const last = s.results[s.results.length - 1]; return <div className="prompt-card"><span className="eyebrow">CHALLENGE {s.challengeIndex + 1} / COMPLETE</span><h2>{last.status === "observed" ? "Gesture observed." : last.status === "partial" ? "Motion observed. Words unverified." : "This check stays unavailable."}</h2><p>{last.detail}</p><div className="prompt-actions"><button className="button button-primary" onClick={this.nextChallenge}>{s.challengeIndex < 2 ? "Next challenge" : s.lightConsent ? "Continue to light check" : "See result"}<Icon name="arrow" size={18} /></button><button className="button button-text" onClick={this.cancel}>Stop camera</button></div></div>; }
    if (s.stage === "reflection") return <div className="prompt-card"><div className="prompt-heading"><span className="eyebrow">OPTIONAL LIGHT RESPONSE</span><span className="mono microcopy">{s.lightStep + 1} / 6</span></div><h2>Keep still. Face the screen.</h2><p>Six slow color plateaus, 1.8 seconds each. A rough cheek-color correlation is measured after each transition settles. This is not validated liveness.</p><div className="color-dots" aria-label={`Current color: ${s.colors[s.lightStep]?.name}`}>{s.colors.map((c, i) => <span key={i} style={{ background: c.hex }} className={i === s.lightStep ? "selected-color" : ""} />)}</div><div className="prompt-actions"><button className="button button-secondary" onClick={() => this.finishLive(noReflection("Light check skipped by the user. An accessible alternative is required."))}>Skip light check</button><button className="button button-text" onClick={this.cancel}>Cancel session</button></div></div>;
    return null;
  }
  render() {
    const s = this.state;
    const active = !["setup", "result"].includes(s.stage);
    const liveCamera = Boolean(s.device) && active;
    const currentStep = s.stage === "result" ? 3 : s.stage === "reflection" ? 2 : ["challenge", "between"].includes(s.stage) ? 1 : 0;
    const c = s.challenges[s.challengeIndex];
    return <><Header active="verify" /><main id="main-content" className="workspace page-width"><div className="page-heading"><div><span className="eyebrow">PRESENCE ENGINE / SANDBOX</span><h1>{s.stage === "result" ? "The evidence, explained." : "Verify the moment."}</h1><p>{s.stage === "result" ? "An auditable demo decision. Never a claim of identity or model accuracy." : "A small set of challenges. A clearer picture of risk."}</p></div><span className="session-tag mono">{s.sessionId || "NEW SESSION"}</span></div>
      <ol className="flow-steps" aria-label="Verification progress">{["Camera check", "Live challenges", "Signal analysis", "Decision"].map((label, i) => <li key={label} className={i === currentStep ? "step-current" : i < currentStep ? "step-done" : ""} aria-current={i === currentStep ? "step" : undefined}><span>{i < currentStep ? <Icon name="check" size={13} /> : `0${i + 1}`}</span>{label}</li>)}</ol>
      {s.stage === "result" && s.result ? <><ResultView result={s.result} sessionLabel={s.sessionId} onReset={this.reset} /><div className="scenario-comparison"><span className="eyebrow">COMPARE SIMULATED OUTCOMES</span><div>{SCENARIOS.map(item => <button key={item.id} className={`button button-secondary ${s.scenario === item.id && s.tab === "lab" ? "selected-scenario-button" : ""}`} onClick={() => this.runSimulation(item.id)}>{item.title}<Icon name="arrow" size={15} /></button>)}</div><p className="microcopy">All four use fictional scores. No replay, injection, or deepfake is actually created or analyzed.</p></div></> : <>
      <div className="verification-grid"><section className="verification-main"><div className="workspace-tabs" role="tablist" aria-label="Verification mode"><button role="tab" aria-selected={s.tab === "live"} aria-controls="verification-panel" disabled={active} onClick={() => this.setState({ tab: "live" })}><Icon name="camera" size={17} />Live webcam</button><button role="tab" aria-selected={s.tab === "lab"} aria-controls="verification-panel" disabled={active} onClick={() => this.setState({ tab: "lab" })}><Icon name="code" size={17} />Attack lab<span className="tab-label">SIMULATED</span></button></div>
        <div id="verification-panel" role="tabpanel" aria-label={s.tab === "live" ? "Live webcam" : "Simulated attack lab"}>
        {s.tab === "live" ? <><div className="active-prompt-slot">{active && this.renderPrompt()}</div><div className={`camera-shell ${s.stage === "reflection" ? "light-active" : ""}`} style={s.stage === "reflection" ? { backgroundColor: s.colors[s.lightStep]?.hex } : undefined}><div className="camera-surface"><video ref={el => { this.video = el; }} autoPlay muted playsInline aria-label="Mirrored local webcam preview" className={liveCamera ? "camera-video" : "camera-video camera-hidden"} /><canvas ref={el => { this.overlay = el; }} className="landmark-overlay" aria-hidden="true" />
          {!liveCamera && <div className="camera-placeholder"><div className="face-frame"><span /><span /><span /><span /><Icon name="scan" size={76} /></div><h2>Presence starts here.</h2><p>Your camera is off until you choose to enable it.</p><span className="camera-private"><Icon name="lock" size={13} />LOCAL PROCESSING ONLY</span></div>}
          {liveCamera && <><div className="camera-badges"><span className="camera-live"><span className="dot" />CAMERA ON</span><span className="camera-fps mono">{s.device?.observedFps ?? "--"} fps observed</span></div><div className={`face-status ${s.faceCount !== 1 ? "face-warning" : ""}`}>{s.model !== "ready" ? "Landmarks not ready" : s.faceCount === 1 ? "One face in frame" : s.faceCount && s.faceCount > 1 ? "Multiple faces - isolate one person" : "Position your face in frame"}</div>{s.stage === "challenge" && c && <div className="camera-prompt-icon">{c.kind === "head" ? <span className={`direction-arrow ${c.direction === "left" ? "arrow-left" : ""}`}><Icon name="arrow" size={32} /></span> : c.kind === "digits" ? <span className="digits-overlay mono">{c.digits?.split("").join(" ")}</span> : <Icon name="eye" size={30} />}</div>}</>}
        </div></div><div className="camera-bottom"><span><Icon name="lock" size={14} />{liveCamera ? "Camera active / not recording" : "No camera data collected"}</span><span>{s.model === "ready" ? "MediaPipe / local" : "No audio capture"}</span></div>
        {s.error && <div className="notice notice-amber" role="alert"><Icon name="info" size={18} /><p>{s.error}</p></div>}{s.modelError && <div className="notice notice-amber" role="alert"><Icon name="info" size={18} /><p>{s.modelError}</p></div>}
        {!active && this.renderPrompt()}
        {s.results.length > 0 && <div className="challenge-history" aria-label="Challenge evidence">{s.results.map((r, i) => <span key={i} className={r.status === "observed" ? "history-observed" : "history-missing"}><Icon name={r.status === "observed" ? "check" : "info"} size={14} />{r.kind}: {r.status}</span>)}</div>}
        </> : <div className="lab-stage"><div className="lab-art"><div className="lab-grid" /><Icon name={s.scenario === "normal" ? "shield" : s.scenario === "virtual" ? "camera" : s.scenario === "replay" ? "play" : "scan"} size={70} /><span className="source-badge source-simulated">Synthetic fixture</span></div><div className="lab-copy"><span className="eyebrow">ATTACK SIMULATION</span><h2>{SCENARIOS.find(item => item.id === s.scenario)!.title}</h2><p>{SCENARIOS.find(item => item.id === s.scenario)!.description}</p><div className="notice notice-amber"><Icon name="info" size={17} /><p>This loads fictional signal scores into the real demo risk function. No media sample is loaded, no attack is executed, and no detector is benchmarked. Camera permission is not needed.</p></div><button className="button button-primary" onClick={() => this.runSimulation()}>Run simulated scenario<Icon name="arrow" size={18} /></button></div></div>}
        </div>
      </section>
      <aside className="verification-sidebar"><section className="panel attack-panel"><div className="panel-heading"><span className="icon-box"><Icon name="code" size={18} /></span><div><h2>Attack simulation</h2><span className="microcopy">Predictable, fictional outcomes</span></div></div><fieldset disabled={active}><legend className="sr-only">Choose a simulated scenario</legend>{SCENARIOS.map(item => <label key={item.id} className={`scenario-option ${s.scenario === item.id && s.tab === "lab" ? "scenario-selected" : ""}`}><input type="radio" name="scenario" value={item.id} checked={s.scenario === item.id} onChange={() => this.setState({ scenario: item.id, tab: "lab" })} /><span><strong>{item.title}</strong><small>{item.description}</small></span></label>)}<button className="button button-secondary full-width" onClick={() => this.runSimulation()}><Icon name="play" size={15} />Run simulation</button></fieldset><p className="panel-footnote">{active ? "Stop the live session before switching scenarios." : "All five scores are simulated in this mode."}</p></section>
      <section className="panel signals-panel"><div className="section-heading"><h2>Signal stack</h2><span className="mono microcopy">5 LAYERS</span></div>{SIGNALS.map((signal, i) => <div className="readiness-row" key={signal.id}><Icon name={signalIcons[i]} size={17} /><div><strong>{signal.title}</strong><span>{i > 2 ? "Real model in the full build" : i === 0 ? s.device ? "Metadata received" : "Waiting for camera" : i === 1 ? s.model === "ready" ? "Landmark engine ready" : "Waiting for landmarks" : s.lightConsent ? "Optional / enabled" : "Optional / off"}</span></div><span className={`readiness-dot ${i > 2 ? "readiness-mock" : i === 0 && s.device || i === 1 && s.model === "ready" ? "readiness-ready" : ""}`} title={i > 2 ? "Simulated" : "Local heuristic"} /></div>)}<div className="signal-legend"><span><i className="readiness-dot readiness-ready" />Local heuristic</span><span><i className="readiness-dot readiness-mock" />Simulated</span></div></section>
      {s.device && <section className="panel device-panel"><span className="eyebrow">OBSERVED CAMERA METADATA</span><dl><div><dt>Device label</dt><dd>{s.device.label || "Unavailable"}</dd></div><div><dt>Resolution</dt><dd>{s.device.width ?? "?"} &times; {s.device.height ?? "?"}</dd></div><div><dt>Reported cadence</dt><dd>{s.device.declaredFps?.toFixed(1) ?? "N/A"} fps</dd></div><div><dt>Observed cadence</dt><dd>{s.device.observedFps ?? "Sampling / unavailable"}{s.device.observedFps !== null ? " fps" : ""}</dd></div></dl><p className="microcopy">Labels and settings are spoofable. Frame cadence can vary with device load; no device ID is collected.</p></section>}
      <PrivacyNote /></aside></div><PrototypeNotice /></>}
    </main><Footer /></>;
  }
}
