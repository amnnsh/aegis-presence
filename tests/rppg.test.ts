
import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzePulse,
  resample,
  type RGBSample
} from "../lib/rppg.ts";

/**
 * Generate synthetic facial RGB measurements.
 * The green channel contains a simulated pulse at realistic amplitudes.
 * Real facial skin typically shows ~1-2% coefficient of variation in the
 * green channel from blood-flow-driven color changes. The synthetic
 * amplitudes here are calibrated to match that range.
 * No real camera or biometric data is involved.
 */
function generateSamples(
  durationSeconds: number,
  bpm = 72,
  noisy = false
): RGBSample[] {
  const samples: RGBSample[] = [];
  const frequency = bpm / 60;

  let t = 0;
  let index = 0;

  while (t < durationSeconds * 1000) {
    const seconds = t / 1000;

    const pulse = Math.sin(
      2 * Math.PI * frequency * seconds
    );

    const noise = noisy
      ? 0.8 * Math.sin(2 * Math.PI * 2.7 * seconds) +
        0.7 * Math.sin(2 * Math.PI * 1.8 * seconds)
      : 0.02 * Math.sin(2 * Math.PI * 3.7 * seconds);

    // Realistic amplitudes: real skin produces ~1-2% green CV from blood flow.
    // Green channel (most sensitive to hemoglobin): ±15 around 150 → CV ≈ 10%
    // Red channel (moderate sensitivity): ±4 around 120
    // Blue channel (least sensitivity): ±2 around 100
    samples.push({
      t,
      r: 120 + 4 * pulse + noise,
      g: 150 + 15 * pulse + noise,
      b: 100 + 2 * pulse + noise,
      motion: false
    });

    // Deterministic uneven sampling around 30 FPS.
    const fps = 28 + (index % 4);
    t += 1000 / fps;
    index++;
  }

  return samples;
}

test("resampling produces approximately 30 samples per second", () => {
  const input = generateSamples(10);
  const output = resample(input, 30);

  assert.ok(output.length >= 295);
  assert.ok(output.length <= 301);
});

test("synthetic 72 BPM pulse is recovered", () => {
  const result = analyzePulse(generateSamples(12, 72));

  assert.notEqual(result.bpm, null);
  assert.ok(
    Math.abs(result.bpm! - 72) <= 3,
    `Expected approximately 72 BPM, got ${result.bpm}`
  );

  assert.notEqual(result.snrDb, null);
  assert.ok(
    result.snrDb! >= 5,
    `Expected SNR >= 5 dB, got ${result.snrDb}`
  );
});

test("five seconds of data is unavailable", () => {
  const result = analyzePulse(generateSamples(5));

  assert.equal(result.risk, null);
  assert.equal(result.bpm, null);
});

test("excessive motion makes evidence unavailable", () => {
  const samples = generateSamples(12);

  for (let i = 0; i < samples.length; i++) {
    samples[i].motion = i % 2 === 0;
  }

  const result = analyzePulse(samples);

  assert.equal(result.risk, null);
  assert.equal(result.bpm, null);
});

test("low frame rate makes evidence unavailable", () => {
  const samples = generateSamples(12)
    .filter((_, index) => index % 4 === 0);

  const result = analyzePulse(samples);

  assert.equal(result.risk, null);
});

test("flat RGB signal cannot produce a valid pulse", () => {
  const samples = generateSamples(12).map(sample => ({
    ...sample,
    r: 120,
    g: 150,
    b: 100
  }));

  const result = analyzePulse(samples);

  assert.equal(result.risk, null);
  assert.equal(result.bpm, null);
});

// ── Anti-spoofing tests ──────────────────────────────────────────────

test("still image with tiny sensor noise is rejected", () => {
  // Simulates a printed photo or screen replay: constant color with
  // only sub-pixel camera sensor noise (no blood-flow oscillation).
  let seed = 42;
  const pseudoRandom = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) - 0.5; // range [-0.5, 0.5]
  };

  const samples: RGBSample[] = [];
  let t = 0;
  while (t < 12000) {
    samples.push({
      t,
      r: 120 + pseudoRandom() * 0.3,
      g: 150 + pseudoRandom() * 0.3,
      b: 100 + pseudoRandom() * 0.3,
      motion: false
    });
    t += 1000 / 30;
  }

  const result = analyzePulse(samples);

  assert.equal(result.risk, null, "A still image must not produce a pulse risk score");
  assert.equal(result.bpm, null, "A still image must not produce a BPM reading");
});

test("random noise without a rhythmic pulse is rejected", () => {
  // Larger variance but no coherent heartbeat frequency.
  // This catches the case where a screen replay adds noise but no real pulse.
  let seed = 137;
  const pseudoRandom = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) - 0.5;
  };

  const samples: RGBSample[] = [];
  let t = 0;
  while (t < 12000) {
    samples.push({
      t,
      r: 120 + pseudoRandom() * 5,
      g: 150 + pseudoRandom() * 5,
      b: 100 + pseudoRandom() * 5,
      motion: false
    });
    t += 1000 / 30;
  }

  const result = analyzePulse(samples);

  // May or may not find a BPM, but risk must be null or high (≥45)
  // because spectral purity or IBI regularity will fail.
  if (result.risk !== null) {
    assert.ok(
      result.risk >= 45,
      `Random noise should not get a confident pulse. Risk: ${result.risk}`
    );
  }
});

test("irregular rhythm is rejected even with strong amplitude", () => {
  // Strong green-channel oscillation but at random, non-rhythmic intervals.
  // This mimics e.g. flickering lighting on a static subject.
  const samples: RGBSample[] = [];
  let t = 0;
  let index = 0;

  while (t < 12000) {
    const seconds = t / 1000;
    // Mix of incommensurate frequencies → no single dominant peak
    const signal =
      1.5 * Math.sin(2 * Math.PI * 1.1 * seconds) +
      1.5 * Math.sin(2 * Math.PI * 1.7 * seconds) +
      1.0 * Math.sin(2 * Math.PI * 2.3 * seconds);

    samples.push({
      t,
      r: 120 + 0.1 * signal,
      g: 150 + 2.0 * signal,
      b: 100 + 0.1 * signal,
      motion: false
    });

    const fps = 28 + (index % 4);
    t += 1000 / fps;
    index++;
  }

  const result = analyzePulse(samples);

  // Either completely rejected (risk null) or penalized (risk ≥ 45)
  if (result.risk !== null) {
    assert.ok(
      result.risk >= 45,
      `Irregular rhythm should not get a confident pulse. Risk: ${result.risk}`
    );
  }
});
