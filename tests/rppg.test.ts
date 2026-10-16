
import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzePulse,
  resample,
  type RGBSample
} from "../lib/rppg.ts";

/**
 * Generate synthetic facial RGB measurements.
 * The green channel contains a simulated pulse.
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

    samples.push({
      t,
      r: 120 + 0.15 * pulse + noise,
      g: 150 + 1.8 * pulse + noise,
      b: 100 + 0.1 * pulse + noise,
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
    result.snrDb! >= 3,
    `Expected SNR >= 3 dB, got ${result.snrDb}`
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
