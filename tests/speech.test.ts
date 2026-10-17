import test from "node:test";
import assert from "node:assert/strict";
import { DigitsCheck } from "../lib/speech.ts";
import type { AudioCapture } from "../lib/audio.ts";
import type { FaceMetrics } from "../lib/types.ts";

test("intelligible input still reaches ASR when lip-sync's noise threshold rejects it", async () => {
  let transcribed = false;
  class WorkerMock {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    listening = false;
    constructor() { queueMicrotask(() => { this.listening = true; this.onmessage?.({ data: { type: "booted" } }); }); }
    postMessage(request: { type: string }) {
      assert.equal(this.listening, true, "Do not post before the worker registers its listener");
      if (request.type === "transcribe") transcribed = true;
      queueMicrotask(() => this.onmessage?.({ data: request.type === "load" ? { type: "ready" } : { type: "result", text: "one two three four" } }));
    }
    terminate() {}
  }
  const original = globalThis.Worker;
  globalThis.Worker = WorkerMock as unknown as typeof Worker;
  try {
    const envelope = Array.from({ length: 300 }, (_, i) => ({ t: i * 10, v: 0.005 + 0.001 * Math.sin(i) }));
    const audio = { begin() {}, stop() {}, end: () => ({ envelope, pcm: Float32Array.from({ length: 48000 }, (_, i) => 0.006 * Math.sin(i)) }) } as unknown as AudioCapture;
    const check = new DigitsCheck(audio, "1234");
    for (let t = 0; t < 3000; t += 50) check.addMouth({ timestamp: t, faceCount: 1, mouthOpen: 0.02 + 0.01 * Math.sin(t) } as FaceMetrics, null);
    const outcome = await check.finish();
    assert.equal(transcribed, true);
    assert.equal(outcome.result.matched, 4);
    assert.equal(outcome.sync.provenance, "unavailable");
  } finally { globalThis.Worker = original; }
});

test("digital silence never reaches ASR even without mouth samples", async () => {
  let transcribed = false;
  class WorkerMock {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    listening = false;
    constructor() { queueMicrotask(() => { this.listening = true; this.onmessage?.({ data: { type: "booted" } }); }); }
    postMessage(request: { type: string }) {
      assert.equal(this.listening, true, "Do not post before the worker registers its listener");
      if (request.type === "transcribe") transcribed = true;
      queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } }));
    }
    terminate() {}
  }
  const original = globalThis.Worker;
  globalThis.Worker = WorkerMock as unknown as typeof Worker;
  try {
    const audio = { begin() {}, stop() {}, end: () => ({ envelope: [{ t: 0, v: 0 }], pcm: new Float32Array(16000) }) } as unknown as AudioCapture;
    const outcome = await new DigitsCheck(audio, "1234").finish();
    assert.equal(transcribed, false);
    assert.equal(outcome.result.status, "unavailable");
    assert.match(outcome.result.detail, /captured silence/);
  } finally { globalThis.Worker = original; }
});
