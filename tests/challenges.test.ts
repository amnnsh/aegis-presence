
import test from "node:test";
import assert from "node:assert/strict";

import {
  challengeHint,
  createChallenges,
  GestureTracker,
  randomInt,
  livenessSignal
} from "../lib/challenges.ts";

import { scoreDigits } from "../lib/digits.ts";

import type {
  ChallengeResult,
  FaceMetrics
} from "../lib/types.ts";

// Default mock facial measurements.
const m = (
  timestamp: number,
  overrides: Partial<FaceMetrics> = {}
): FaceMetrics => ({
  timestamp,
  faceCount: 1,
  yaw: 0,
  yawDeg: 0,
  pitchDeg: 0,
  rollDeg: 0,
  blinkLeft: 0,
  blinkRight: 0,
  jawOpen: 0,
  mouthOpen: 0,
  points: [],
  ...overrides
});

// Helper for synthetic head-pose measurements.
const pose = (
  timestamp: number,
  yawDeg: number,
  pitchDeg = 0,
  rollDeg = 0
): FaceMetrics =>
  m(timestamp, {
    yawDeg,
    pitchDeg,
    rollDeg
  });

test("sessions include all three shuffled prompts and four random digits", () => {
  const signatures = new Set<string>();

  for (let i = 0; i < 20; i++) {
    const c = createChallenges();

    assert.deepEqual(
      c.map(s => s.kind).sort(),
      ["blink", "digits", "head"]
    );

    assert.match(
      c.find(s => s.kind === "digits")!.digits!,
      /^\d{4}$/
    );

    signatures.add(JSON.stringify(c));
  }

  assert.ok(signatures.size > 1);
});

test("random ranges are checked", () => {
  assert.throws(() => randomInt(0));
  assert.throws(() => randomInt(1.5));

  for (let i = 0; i < 50; i++) {
    assert.ok(randomInt(3) < 3);
  }
});

// ------------------------------------------
// HEAD-POSE RECOGNITION TESTS
// ------------------------------------------

test("head prompt requires calibration, turn, AND return", () => {
  const tracker = new GestureTracker({
    kind: "head",
    direction: "right"
  });

  // Eight neutral calibration frames.
  for (let i = 0; i < 8; i++) {
    assert.equal(
      tracker.update(pose(i * 100, 0)),
      null
    );
  }

  // Physical RIGHT produces negative yaw.
  // Five observations are needed for the rolling window.
  for (let i = 8; i < 13; i++) {
    assert.equal(
      tracker.update(pose(i * 100, -25)),
      null
    );
  }

  assert.equal(
    tracker.progress,
    "Now return to center"
  );

  // Three stable frames at neutral.
  assert.equal(tracker.update(pose(1300, 0)), null);
  assert.equal(tracker.update(pose(1400, 0)), null);

  const result = tracker.update(pose(1500, 0));

  assert.equal(result?.status, "observed");
  assert.equal(result?.kind, "head");
  assert.equal(result?.risk, 10);
});

test("physical left turn uses positive 3D yaw", () => {
  const tracker = new GestureTracker({
    kind: "head",
    direction: "left"
  });

  for (let i = 0; i < 8; i++) {
    assert.equal(
      tracker.update(pose(i * 100, 0)),
      null
    );
  }

  // Physical LEFT produces positive yaw.
  for (let i = 8; i < 13; i++) {
    assert.equal(
      tracker.update(pose(i * 100, 25)),
      null
    );
  }

  assert.equal(
    tracker.progress,
    "Now return to center"
  );

  tracker.update(pose(1300, 0));
  tracker.update(pose(1400, 0));

  const result = tracker.update(pose(1500, 0));

  assert.equal(result?.status, "observed");
  assert.equal(result?.kind, "head");
});

test("wrong head direction never completes", () => {
  const tracker = new GestureTracker({
    kind: "head",
    direction: "left"
  });

  for (let i = 0; i < 8; i++) {
    tracker.update(pose(i * 100, 0));
  }

  // Negative yaw means RIGHT, not LEFT.
  for (let i = 8; i < 20; i++) {
    assert.equal(
      tracker.update(pose(i * 100, -25)),
      null
    );
  }

  assert.notEqual(
    tracker.progress,
    "Now return to center"
  );

  assert.equal(
    tracker.unavailable().status,
    "unavailable"
  );
});

test("rolling window tolerates two noisy frames", () => {
  const tracker = new GestureTracker({
    kind: "head",
    direction: "left"
  });

  for (let i = 0; i < 8; i++) {
    tracker.update(pose(i * 100, 0));
  }

  // Three valid positive yaw readings among five.
  const readings = [24, 3, 26, 2, 25];

  readings.forEach((yaw, index) => {
    tracker.update(pose((index + 8) * 100, yaw));
  });

  assert.equal(
    tracker.progress,
    "Now return to center"
  );

  tracker.update(pose(1300, 0));
  tracker.update(pose(1400, 0));

  assert.equal(
    tracker.update(pose(1500, 0))?.status,
    "observed"
  );
});

test("single head-turn spike cannot pass", () => {
  const tracker = new GestureTracker({
    kind: "head",
    direction: "right"
  });

  for (let i = 0; i < 8; i++) {
    tracker.update(pose(i * 100, 0));
  }

  const readings = [-30, 0, 0, 0, 0];

  readings.forEach((yaw, index) => {
    tracker.update(pose((index + 8) * 100, yaw));
  });

  assert.notEqual(
    tracker.progress,
    "Now return to center"
  );
});

test("missing 3D head pose never passes", () => {
  const tracker = new GestureTracker({
    kind: "head",
    direction: "left"
  });

  for (let i = 0; i < 20; i++) {
    const frame = m(i * 100, {
      yaw: 0.5,
      yawDeg: undefined,
      pitchDeg: undefined,
      rollDeg: undefined
    });

    assert.equal(tracker.update(frame), null);
  }

  assert.equal(
    tracker.unavailable().status,
    "unavailable"
  );
});

test("multiple faces reset head calibration", () => {
  const tracker = new GestureTracker({
    kind: "head",
    direction: "right"
  });

  for (let i = 0; i < 8; i++) {
    tracker.update(pose(i * 100, 0));
  }

  tracker.update(
    m(800, { faceCount: 2 })
  );

  assert.equal(
    tracker.progress,
    "Center your face to calibrate"
  );
});

test("excessive sideways tilt does not count as a head turn", () => {
  const tracker = new GestureTracker({
    kind: "head",
    direction: "left"
  });

  for (let i = 0; i < 8; i++) {
    tracker.update(pose(i * 100, 0));
  }

  for (let i = 8; i < 15; i++) {
    assert.equal(
      tracker.update(pose(i * 100, 25, 0, 35)),
      null
    );
  }

  assert.notEqual(
    tracker.progress,
    "Now return to center"
  );
});

// ------------------------------------------
// BLINK AND MOUTH-MOVEMENT TESTS
// ------------------------------------------

test("two genuine open/closed/open cycles are needed for blinks", () => {
  const tracker = new GestureTracker({
    kind: "blink"
  });

  tracker.update(m(0));

  tracker.update(
    m(100, {
      blinkLeft: 0.9,
      blinkRight: 0.9
    })
  );

  assert.equal(tracker.update(m(200)), null);

  tracker.update(
    m(400, {
      blinkLeft: 0.9,
      blinkRight: 0.9
    })
  );

  assert.equal(
    tracker.update(m(500))?.status,
    "observed"
  );
});

test("constant closed eyes and multiple faces cannot pass", () => {
  const tracker = new GestureTracker({
    kind: "blink"
  });

  for (let i = 0; i < 20; i++) {
    assert.equal(
      tracker.update(
        m(i * 100, {
          blinkLeft: 0.9,
          blinkRight: 0.9
        })
      ),
      null
    );
  }

  assert.equal(
    tracker.update(
      m(2100, { faceCount: 2 })
    ),
    null
  );

  assert.equal(
    tracker.unavailable().status,
    "unavailable"
  );
});

test("without a microphone, mouth motion is partial, NEVER digit verification", () => {
  const tracker = new GestureTracker({
    kind: "digits",
    digits: "1234"
  });

  tracker.update(m(0));
  tracker.update(m(100, { jawOpen: 0.8 }));
  tracker.update(m(200));
  tracker.update(m(400, { jawOpen: 0.8 }));

  const result = tracker.update(m(500));

  assert.equal(result?.status, "partial");
  assert.equal(result?.risk, 60);
  assert.match(result!.detail, /NOT verified/);
});

// ------------------------------------------
// LIVENESS RISK TESTS
// ------------------------------------------

test("no completed gestures means unavailable liveness", () => {
  assert.equal(livenessSignal([]).risk, null);
});

const gesture = (
  kind: "head" | "blink"
): ChallengeResult => ({
  kind,
  status: "observed",
  risk: 10,
  detail: ""
});

test("mouth-only digits still contribute a fixed 60 to liveness", () => {
  const partial: ChallengeResult = {
    kind: "digits",
    status: "partial",
    risk: 60,
    detail: ""
  };

  const signal = livenessSignal([
    gesture("head"),
    gesture("blink"),
    partial
  ]);

  assert.equal(signal.risk, 27);

  assert.match(
    signal.detail,
    /2\/2 head \/ blink/
  );

  assert.match(
    signal.detail,
    /unverified and contributes risk 60/
  );

  assert.equal(
    livenessSignal([partial]).risk,
    null
  );
});

test("recognized digits replace the fixed 60; wrong digits raise liveness risk", () => {
  const right = livenessSignal([
    gesture("head"),
    gesture("blink"),
    scoreDigits("4071", "four oh seven one")
  ]);

  assert.equal(right.risk, 10);

  assert.match(
    right.detail,
    /4\/4 recognized on-device/
  );

  assert.equal(
    livenessSignal([
      gesture("head"),
      gesture("blink"),
      scoreDigits("4071", "four oh seven")
    ]).risk,
    20
  );

  const wrong = livenessSignal([
    gesture("head"),
    gesture("blink"),
    scoreDigits("4071", "nine two five three")
  ]);

  assert.equal(wrong.risk, 32);

  assert.match(
    wrong.detail,
    /0\/4 recognized/
  );
});

test("digits heard but gestures skipped: digits count, missing gestures cost 60 each", () => {
  const signal = livenessSignal([
    scoreDigits("4071", "4 0 7 1")
  ]);

  assert.equal(signal.risk, 43);

  assert.match(
    signal.detail,
    /0\/2 head \/ blink/
  );
});

test("an empty transcript is unavailable and costs 60, never a pass", () => {
  const none = scoreDigits("4071", "");

  assert.equal(none.status, "unavailable");

  assert.equal(
    livenessSignal([
      gesture("head"),
      gesture("blink"),
      none
    ]).risk,
    27
  );
});

test("the digits hint says truthfully whether the microphone is used", () => {
  assert.match(
    challengeHint({
      kind: "digits",
      digits: "1234"
    }),
    /microphone is off/
  );

  assert.match(
    challengeHint(
      {
        kind: "digits",
        digits: "1234"
      },
      true
    ),
    /on this device/
  );
});

test("unstable neutral calibration cannot complete", () => {
  const tracker = new GestureTracker({
    kind: "head",
    direction: "right"
  });

  const unstable = [0, -15, 3, -18, 2, -20, 1, -16];

  unstable.forEach((yaw, index) => {
    tracker.update(pose(index * 100, yaw));
  });

  assert.equal(
    tracker.progress,
    "Center your face to calibrate"
  );
});