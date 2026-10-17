import type { Sample } from "./sync.ts";

export const ASR_SAMPLE_RATE = 16000;
export const MAX_RECORD_MS = 8000;
const WORKLET_URL = "/worklets/audio-capture.js";

/** Linear-interpolation resampler with box averaging when downsampling. Pure; adequate for a short speech clip. */
export function resampleTo(input: Float32Array, fromRate: number, toRate = ASR_SAMPLE_RATE): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = i * ratio;
    if (ratio > 1) {
      const end = Math.min(input.length, Math.max(Math.floor(start) + 1, Math.floor(start + ratio)));
      let sum = 0;
      for (let j = Math.floor(start); j < end; j++) sum += input[j];
      out[i] = sum / (end - Math.floor(start));
    } else {
      const left = Math.floor(start), right = Math.min(input.length - 1, left + 1);
      out[i] = input[left] + (input[right] - input[left]) * (start - left);
    }
  }
  return out;
}

/** Apply one bounded gain to the transcription copy only; preserve the raw lip-sync envelope.
 * Never amplify digital silence, never attenuate normal speech, and leave peak headroom.
 */
export function normalizeSpeech(pcm: Float32Array): Float32Array {
  let peak = 0;
  for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
  if (!Number.isFinite(peak) || peak < 0.001) return pcm;
  const gain = Math.min(20, 0.8 / peak);
  if (gain <= 1) return pcm;
  return pcm.map(sample => sample * gain);
}

export function microphoneError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone permission was not granted. The spoken-digit and lip-sync checks stay unavailable; nothing is simulated in their place.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. The spoken-digit and lip-sync checks stay unavailable.";
  if (name === "NotReadableError") return "The microphone is in use by another app. The spoken-digit and lip-sync checks stay unavailable.";
  return "The microphone could not be started. The spoken-digit and lip-sync checks stay unavailable.";
}

/** Owns the microphone, the AudioContext, and the worklet. No persistence, uploads, or MediaRecorder.
 * open() asks for permission; samples are kept ONLY between begin() and end(), in memory, capped at 8 seconds.
 * stop() releases everything and is safe to call repeatedly (cancel, hidden tab, unmount).
 */
export class AudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private stopped = false;
  private recording = false;
  private chunks: Float32Array[] = [];
  private samples = 0;
  private levels: { contextMs: number; v: number }[] = [];
  private clockOffset = Infinity; // performance.now() minus audio-context time; the minimum seen removes message delay
  private onEnded = () => this.stop();

  static supported(): boolean {
    return typeof window !== "undefined" && window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia)
      && typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined";
  }
  get active(): boolean { return !this.stopped && this.node !== null; }

  async open(): Promise<void> {
    if (!AudioCapture.supported()) throw new Error("Audio capture is not supported in this browser.");
    // Processing is disabled on purpose: echo cancellation and noise suppression reshape the loudness envelope.
    const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    // A permission dialog can outlive cancellation. Close late streams immediately.
    if (this.stopped) { stream.getTracks().forEach(t => t.stop()); return; }
    this.stream = stream;
    stream.getAudioTracks()[0]?.addEventListener("ended", this.onEnded);
    try {
      // Capture at the browser's device rate. Forcing 16 kHz here can prevent
      // Firefox versions from connecting the microphone; end() resamples for ASR.
      const context = new AudioContext({ latencyHint: "interactive" });
      this.context = context;
      await context.audioWorklet.addModule(WORKLET_URL);
      if (this.stopped) return;
      const node = new AudioWorkletNode(context, "aegis-capture", { numberOfInputs: 1, numberOfOutputs: 1 });
      node.port.onmessage = event => this.onChunk(event.data);
      const silent = context.createGain(); silent.gain.value = 0; // keeps the graph pulled without playing the mic back
      context.createMediaStreamSource(stream).connect(node); node.connect(silent); silent.connect(context.destination);
      this.node = node;
      if (context.state === "suspended") await context.resume();
    } catch (error) { this.stop(); throw error; }
  }
  private onChunk(data: { firstWindowEnd: number; sentAt: number; rms: Float32Array; pcm: Float32Array }) {
    if (!this.recording) return;
    this.clockOffset = Math.min(this.clockOffset, performance.now() - data.sentAt * 1000);
    for (let i = 0; i < data.rms.length; i++) this.levels.push({ contextMs: (data.firstWindowEnd + i * 0.01) * 1000 - 5, v: data.rms[i] });
    const limit = Math.round((this.context?.sampleRate ?? ASR_SAMPLE_RATE) * MAX_RECORD_MS / 1000);
    if (this.samples < limit) {
      const chunk = data.pcm.subarray(0, Math.min(data.pcm.length, limit - this.samples));
      this.chunks.push(chunk); this.samples += chunk.length;
    }
  }
  /** Start keeping samples. Nothing is kept before this call. */
  begin(): void {
    if (!this.active) return;
    this.chunks = []; this.samples = 0; this.levels = []; this.clockOffset = Infinity; this.recording = true;
    this.node!.port.postMessage({ recording: true });
  }
  /** Loudness every 10 ms, on the performance.now() clock (approximate: capture latency is not compensated). */
  get envelope(): Sample[] {
    return Number.isFinite(this.clockOffset) ? this.levels.map(level => ({ t: level.contextMs + this.clockOffset, v: level.v })) : [];
  }
  get recordedMs(): number { return this.samples * 1000 / (this.context?.sampleRate ?? ASR_SAMPLE_RATE); }
  /** Stop keeping samples and hand over what was captured: the envelope and mono 16 kHz PCM. */
  end(): { envelope: Sample[]; pcm: Float32Array } {
    const envelope = this.envelope;
    const merged = new Float32Array(this.samples);
    let offset = 0;
    for (const chunk of this.chunks) { merged.set(chunk, offset); offset += chunk.length; }
    const pcm = resampleTo(merged, this.context?.sampleRate ?? ASR_SAMPLE_RATE);
    this.recording = false; this.chunks = []; this.samples = 0; this.levels = [];
    this.node?.port.postMessage({ recording: false });
    return { envelope, pcm };
  }
  stop(): void {
    this.stopped = true; this.recording = false; this.chunks = []; this.samples = 0; this.levels = [];
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); this.node = null; }
    this.stream?.getTracks().forEach(t => { t.removeEventListener("ended", this.onEnded); t.stop(); });
    this.stream = null;
    const context = this.context; this.context = null;
    if (context && context.state !== "closed") context.close().catch(() => undefined);
  }
}

