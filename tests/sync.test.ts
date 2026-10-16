import test from "node:test";
import assert from "node:assert/strict";
import { crossCorrelate, resample, syncSignal, voiceThreshold } from "../lib/sync.ts";
import type { Sample } from "../lib/sync.ts";
import { normalizeSpeech, resampleTo } from "../lib/audio.ts";

// Speech-like test shape: an irregular syllable rhythm, so only one lag lines the two series up.
const shape = (t: number) => Math.max(0, Math.sin(2 * Math.PI * 2.1 * t / 1000) + 0.6 * Math.sin(2 * Math.PI * 3.3 * t / 1000 + 1));
const series = (stepMs: number, durationMs: number, f: (t: number) => number, t0 = 1000): Sample[] =>
  Array.from({ length: Math.floor(durationMs / stepMs) }, (_, i) => ({ t: t0 + i * stepMs, v: f(t0 + i * stepMs) }));
const mouth = (delayMs = 0) => series(50, 6000, t => 0.02 + 0.08 * shape(t - delayMs)); // ~20 Hz landmarks
const audio = (delayMs = 0) => series(10, 6000, t => 0.004 + 0.2 * shape(t - delayMs)); // 100 Hz loudness
function noise(seed: number) { let x = seed; return () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; }; }

test("identical shapes correlate strongly at about zero lag", () => {
  const result = crossCorrelate(mouth(), audio())!;
  assert.ok(result.peakCorr > 0.9, `peak ${result.peakCorr}`);
  assert.ok(Math.abs(result.lagMs) <= 20, `lag ${result.lagMs}`);
  assert.ok(result.voicedFraction > 0.3);
  assert.equal(syncSignal(result).risk, 15); assert.equal(syncSignal(result).provenance, "heuristic");
});
test("audio delayed by 150 ms reports a lag of about +150 ms; an early one is negative", () => {
  const late = crossCorrelate(mouth(), audio(150))!;
  assert.ok(late.peakCorr > 0.9); assert.ok(Math.abs(late.lagMs - 150) <= 20, `lag ${late.lagMs}`);
  const early = crossCorrelate(mouth(150), audio())!;
  assert.ok(Math.abs(early.lagMs + 150) <= 20, `lag ${early.lagMs}`);
  assert.equal(syncSignal(late).risk, 15);
});
test("a strong match outside the 200 ms tolerance is not a pass", () => {
  const result = crossCorrelate(mouth(), audio(260))!;
  assert.ok(result.peakCorr >= 0.5 && Math.abs(result.lagMs) > 200, JSON.stringify(result));
  assert.equal(syncSignal(result).risk, 80);
});
test("independent noise stays below the weak-correlation threshold", () => {
  for (const seed of [1, 7, 42, 1234, 99991]) {
    const a = noise(seed), b = noise(seed * 31 + 5);
    const result = crossCorrelate(series(50, 8000, () => 0.02 + 0.08 * a()), series(10, 8000, () => 0.02 + 0.2 * b()))!;
    assert.ok(result.peakCorr < 0.3, `seed ${seed}: ${result.peakCorr}`);
    assert.notEqual(syncSignal({ ...result, voicedFraction: 0.5 }).risk, 15);
  }
});
test("thresholds: 0.5 with small lag -> 15, 0.3-0.5 -> 40, otherwise 80", () => {
  const at = (peakCorr: number, lagMs = 40) => syncSignal({ peakCorr, lagMs, voicedFraction: 0.5 }).risk;
  assert.deepEqual([at(0.5), at(0.49), at(0.3), at(0.29), at(0.9, 220), at(0.9, -200)], [15, 40, 40, 80, 80, 15]);
});
test("silence, a steady loud room, and missing data are unavailable, never a pass", () => {
  const silent = crossCorrelate(mouth(), series(10, 6000, () => 0.001))!;
  assert.equal(silent.voicedFraction, 0);
  assert.equal(syncSignal(silent).risk, null); assert.equal(syncSignal(silent).provenance, "unavailable");
  const fan = crossCorrelate(mouth(), series(10, 6000, t => 0.05 + 0.002 * Math.sin(t)))!;
  assert.equal(syncSignal(fan).provenance, "unavailable");
  assert.equal(crossCorrelate(mouth(), []), null);
  assert.equal(crossCorrelate(series(50, 600, shape), series(10, 600, shape)), null); // under one second
  assert.equal(syncSignal(null).risk, null);
});
test("voice present with a motionless mouth is high risk", () => {
  const result = crossCorrelate(series(50, 6000, () => 0.03), audio())!;
  assert.equal(result.peakCorr, 0); assert.equal(syncSignal(result).risk, 80);
});
test("resampling: dense input is averaged, sparse input is interpolated", () => {
  assert.deepEqual(Array.from(resample([{ t: 0, v: 0 }, { t: 100, v: 10 }], 0, 6, 20)), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(Array.from(resample(series(5, 80, t => t < 10 ? 1 : 3, 0), 10, 2, 20)), [2, 3]);
  assert.equal(voiceThreshold([]), 0.001);
});
test("PCM resampling to 16 kHz keeps duration and tone", () => {
  const input = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(2 * Math.PI * 200 * i / 48000));
  const out = resampleTo(input, 48000);
  assert.equal(out.length, 16000);
  assert.ok(Math.abs(out[20] - Math.sin(2 * Math.PI * 200 * 61 / 48000)) < 0.02);
  assert.equal(resampleTo(input, 16000), input);
  assert.equal(resampleTo(Float32Array.from([0, 1]), 8000).length, 4);
});


test("quiet speech below the old volume floor is detected with unchanged timing", () => {
  const quiet = audio(150).map(sample => ({ ...sample, v: sample.v * 0.02 }));
  assert.ok(Math.max(...quiet.map(sample => sample.v)) < 0.01);
  const result = crossCorrelate(mouth(), quiet)!;
  assert.ok(result.voicedFraction > 0.3);
  assert.ok(Math.abs(result.lagMs - 150) <= 20);
  assert.equal(syncSignal(result).risk, 15);
});

test("quiet background fluctuations and digital silence do not count as speech", () => {
  for (const level of [0, 0.0001, 0.001, 0.004]) {
    const background = series(10, 6000, t => level * (1 + 0.1 * Math.sin(t)));
    assert.equal(crossCorrelate(mouth(), background)!.voicedFraction, 0);
  }
});

test("transcription gain lifts quiet PCM without changing the source or timing", () => {
  const pcm = Float32Array.from([0, 0.005, -0.01, 0.002]);
  const original = pcm.slice();
  const normalized = normalizeSpeech(pcm);
  assert.equal(normalized.length, pcm.length);
  assert.deepEqual(pcm, original);
  for (let i = 0; i < pcm.length; i++) assert.ok(Math.abs(normalized[i] - pcm[i] * 20) < 1e-7);
});

test("transcription gain is bounded, avoids clipping, and leaves silence alone", () => {
  for (const pcm of [new Float32Array(), new Float32Array(160), Float32Array.of(0.00001), Float32Array.of(-0.9, 0.9)]) {
    assert.equal(normalizeSpeech(pcm), pcm);
  }
  const normalized = normalizeSpeech(Float32Array.of(-0.2, 0.1));
  assert.ok(Math.abs(normalized[0] + 0.8) < 1e-7);
  assert.ok(Math.abs(normalized[1] - 0.4) < 1e-7);
});
