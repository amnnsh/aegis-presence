import type { AudioCapture } from "./audio.ts";
import { MAX_RECORD_MS, normalizeSpeech } from "./audio.ts";
import type { AsrRequest, AsrResponse } from "./asr.worker.ts";
import { scoreDigits } from "./digits.ts";
import { crossCorrelate, syncSignal, voiceThreshold } from "./sync.ts";
import type { Sample, SyncResult } from "./sync.ts";
import type { ChallengeResult, FaceMetrics, Signal } from "./types.ts";

const LOAD_TIMEOUT_MS = 45000;
const TRANSCRIBE_TIMEOUT_MS = 30000;
const END_SILENCE_MS = 1500; // a slow reader pauses between digits; ending early would cut the prompt short
const MIN_SPEECH_MS = 1500;

/** Lazily starts the speech worker. Every failure resolves to null: the caller falls back to mouth-only evidence. */
class SpeechModel {
  private worker: Worker | null = null;
  private waiting: ((message: AsrResponse | null) => void) | null = null;
  private ready: Promise<boolean>;
  percent = 0;
  state: "loading" | "ready" | "failed" = "loading";
  error = "";
  constructor() {
    try {
      this.worker = new Worker(new URL("./asr.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (event: MessageEvent<AsrResponse>) => {
        if (event.data.type === "booted") { this.worker?.postMessage({ type: "load" }); return; }
        if (event.data.type === "progress") { this.percent = event.data.percent; return; }
        if (event.data.type === "error") this.error = "The on-device speech model or its runtime failed.";
        const done = this.waiting; this.waiting = null; done?.(event.data);
      };
      this.worker.onerror = () => { this.error = "The speech worker could not start."; const done = this.waiting; this.waiting = null; done?.(null); };
    } catch { this.error = "The speech worker could not be created."; this.worker = null; }
    this.ready = this.ask({ type: "load" }, LOAD_TIMEOUT_MS).then(message => {
      this.state = message?.type === "ready" ? "ready" : "failed";
      return this.state === "ready";
    });
  }
  private ask(request: AsrRequest, timeoutMs: number): Promise<AsrResponse | null> {
    const worker = this.worker;
    if (!worker) return Promise.resolve(null);
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.error = request.type === "load" ? "The speech model took too long to load." : "Speech recognition took too long to answer."; this.waiting = null; resolve(null); }, timeoutMs);
      this.waiting = message => { clearTimeout(timer); resolve(message); };
      // A bundled worker can still be initializing its imports when constructed.
      // Its booted message triggers load; later requests have a live listener.
      if (request.type !== "load") worker.postMessage(request);
    });
  }
  async transcribe(pcm: Float32Array): Promise<string | null> {
    if (!(await this.ready)) return null;
    const message = await this.ask({ type: "transcribe", pcm }, TRANSCRIBE_TIMEOUT_MS);
    return message?.type === "result" ? message.text : null;
  }
  dispose() { this.worker?.terminate(); this.worker = null; const done = this.waiting; this.waiting = null; done?.(null); }
}

export interface DigitsOutcome {
  result: ChallengeResult;
  sync: Signal;
  /** Numbers only. This is all that may be reported to the backend: never audio, never the transcript. */
  metrics: { peakCorr: number | null; lagMs: number | null; voicedFraction: number | null; digitsMatched: number | null };
}

/** One microphone-backed digits prompt: records between construction and finish(), entirely on this device.
 * The audio buffer exists only in memory, is handed to the local speech worker, and is dropped afterwards.
 */
export class DigitsCheck {
  private audio: AudioCapture;
  private expected: string;
  private model = new SpeechModel();
  private mouth: Sample[] = [];
  private mouthResult: ChallengeResult | null = null;
  private closed = false;
  constructor(audio: AudioCapture, expected: string) { this.audio = audio; this.expected = expected; audio.begin(); }

  /** mouthResult is the existing jaw-motion heuristic's verdict, kept as the fallback when speech cannot be checked. */
  addMouth(m: FaceMetrics, mouthResult: ChallengeResult | null) {
    if (mouthResult) this.mouthResult = mouthResult;
    if (!this.closed && m.faceCount === 1) this.mouth.push({ t: m.timestamp, v: m.mouthOpen });
  }
  private voice(): { first: number; last: number; now: number } | null {
    const envelope = this.audio.envelope;
    if (envelope.length === 0) return null;
    const threshold = voiceThreshold(envelope.map(sample => sample.v));
    const voiced = envelope.filter(sample => sample.v > threshold);
    return voiced.length < 5 ? null : { first: voiced[0].t, last: voiced[voiced.length - 1].t, now: envelope[envelope.length - 1].t };
  }
  get progress(): string {
    const loading = this.model.state === "loading" ? ` Loading speech model... ${this.model.percent}%` : "";
    if (this.model.state === "failed") return "Speech recognition is unavailable. You can skip this challenge and try again.";
    const recent = this.audio.envelope.slice(-20);
    const level = recent.reduce((sum, sample) => sum + sample.v, 0) / Math.max(1, recent.length);
    return (this.voice() ? "Voice detected. Finish all four digits, then pause." : level > 0.00001
      ? "Microphone input received. Read all four digits at your normal volume."
      : "No microphone input yet. Check your microphone and read the four digits.") + loading;
  }
  /** True after the speaker pauses, or when the 8-second recording cap is reached. */
  done(): boolean {
    if (!this.audio.active || this.audio.recordedMs >= MAX_RECORD_MS) return true;
    const voice = this.voice();
    return voice !== null && voice.now - voice.last >= END_SILENCE_MS && voice.now - voice.first >= MIN_SPEECH_MS;
  }
  cancel() { this.closed = true; this.model.dispose(); this.audio.stop(); }

  async finish(): Promise<DigitsOutcome> {
    this.closed = true;
    const { envelope, pcm } = this.audio.end();
    this.audio.stop(); // release the microphone as soon as the prompt ends
    const measured: SyncResult | null = crossCorrelate(this.mouth, envelope);
    const sync = syncSignal(measured, envelope.length === 0 ? "No audio was captured." : this.mouth.length < 2 ? "No single-face mouth samples were captured during the prompt." : undefined);
    const fallback = (why: string): ChallengeResult => this.mouthResult
      ? { ...this.mouthResult, detail: `${why} Falling back to mouth motion only: ${this.mouthResult.detail}` }
      : { kind: "digits", status: "unavailable", risk: null, detail: `${why} No mouth-motion evidence either. Missing evidence is not a pass.` };
    let result: ChallengeResult;
    if (envelope.length === 0) result = fallback("No audio was captured.");
    // Lip-sync's adaptive threshold is not a speech recognizer. A noisy room or
    // continuous speech can fail that heuristic while containing intelligible words.
    // Only near-digital silence skips ASR; keep the independent sync verdict intact.
    else if (!pcm.some(sample => Math.abs(sample) > 0.00001)) { result = { kind: "digits", status: "unavailable", risk: null, heard: "", matched: 0, detail: "The microphone captured silence. Check the selected microphone and its input level, then retry. Missing evidence is not a pass." }; }
    else {
      const text = await this.model.transcribe(normalizeSpeech(pcm));
      result = text === null ? fallback(`${this.model.error || "The on-device speech model is unavailable."} The spoken digits were NOT verified.`) : scoreDigits(this.expected, text);
    }
    this.model.dispose();
    return { result, sync, metrics: {
      peakCorr: measured ? Math.round(measured.peakCorr * 1000) / 1000 : null, lagMs: measured?.lagMs ?? null,
      voicedFraction: measured ? Math.round(measured.voicedFraction * 1000) / 1000 : null,
      digitsMatched: typeof result.matched === "number" && result.heard !== undefined ? result.matched : null } };
  }
}

