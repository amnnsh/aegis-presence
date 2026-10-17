import type {
  BlinkTiming,
  Challenge,
  ChallengeResult,
  ClientEvent,
  EventType,
  FaceMetrics,
  HeadMove,
  MoveTiming,
  Plan,
  Signal
} from "./types.ts";

import { deflection, MOVE_AXIS, MOVES } from "./head-pose.ts";

export function randomInt(max: number): number {
  if (
    !Number.isSafeInteger(max) ||
    max < 1 ||
    max > 0x100000000
  ) {
    throw new Error("Invalid random range");
  }

  const limit =
    Math.floor(0x100000000 / max) * max;

  const data = new Uint32Array(1);

  do {
    globalThis.crypto.getRandomValues(data);
  } while (data[0] >= limit);

  return data[0] % max;
}

export function shuffle<T>(items: T[]): T[] {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);

    [result[i], result[j]] = [
      result[j],
      result[i]
    ];
  }

  return result;
}

/** Epoch milliseconds on the monotonic page clock. Used for every logged event. */
export function epochNow(): number {
  return Math.round(performance.timeOrigin + performance.now());
}

// ------------------------------------------
// LOCAL PLAN (mirrors backend/app/plan.py)
// ------------------------------------------

export const PULSE_HOLD_MS = 12000;
export const CUE_GAP_MIN_MS = 1500;
export const CUE_GAP_MAX_MS = 4000;

function challengeId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return "c_" + Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/** Random moves with no immediate repeat. */
export function randomMoves(count = 3): HeadMove[] {
  const moves: HeadMove[] = [];
  for (let i = 0; i < count; i++) {
    const options = MOVES.filter(m => m !== moves[moves.length - 1]);
    moves.push(options[randomInt(options.length)]);
  }
  return moves;
}

/** Cumulative cue offsets with random 1.5-4 s gaps. */
export function randomCueOffsets(count = 3): number[] {
  const offsets: number[] = [];
  let previous = 0;
  for (let i = 0; i < count; i++) {
    previous += CUE_GAP_MIN_MS + randomInt(CUE_GAP_MAX_MS - CUE_GAP_MIN_MS + 1);
    offsets.push(previous);
  }
  return offsets;
}

/** Same shape as the server plan; used when no backend is configured or reachable. */
export function createPlan(): Plan {
  return {
    challenges: shuffle<Challenge>([
      { id: challengeId(), kind: "head_sequence", moves: randomMoves() },
      { id: challengeId(), kind: "cued_blink", cue_offsets_ms: randomCueOffsets() },
      {
        id: challengeId(),
        kind: "digits",
        digits: Array.from({ length: 4 }, () => randomInt(10)).join("")
      }
    ]),
    pulse_hold_ms: PULSE_HOLD_MS
  };
}

// ------------------------------------------
// COPY
// ------------------------------------------

export function challengeTitle(c: Challenge): string {
  if (c.kind === "head_sequence") {
    return `Follow ${c.moves.length} head arrows`;
  }

  if (c.kind === "cued_blink") {
    return "Blink when the ring flashes";
  }

  return `Read ${c.digits.split("").join(" ")} aloud`;
}

export function challengeHint(
  c: Challenge,
  microphone = false
): string {
  if (c.kind === "head_sequence") {
    return "Look straight ahead to calibrate. An arrow appears on the camera: turn or tilt your head that way, hold briefly, then return to center. The next arrow follows automatically. Left means your own left.";
  }

  if (c.kind === "cued_blink") {
    return "Keep your eyes open and watch the camera. Each time the ring around it flashes, blink once. Blinks at other times are ignored.";
  }

  if (microphone) {
    return "Read all four digits aloud at a steady pace, then pause. Your voice is transcribed and compared with your lip movement on this device. No audio is uploaded or kept.";
  }

  return "Only mouth movement is observed. The digits and your voice are NOT recognized or verified. The microphone is off.";
}

const MOVE_WORDS: Record<HeadMove, string> = {
  left: "Turn your head to your LEFT",
  right: "Turn your head to your RIGHT",
  up: "Tilt your head UP",
  down: "Tilt your head DOWN"
};

// ------------------------------------------
// TRACKERS
// ------------------------------------------

/** What the camera overlay should show right now. */
export type CueDisplay =
  | { type: "center" }
  | { type: "arrow"; move: HeadMove; step: number; total: number; wrong: boolean }
  | { type: "ring"; index: number }
  | null;

export interface ChallengeTracker {
  readonly challenge: Challenge;
  /** Hint text for the prompt card. */
  readonly progress: string;
  /** Overlay cue as of the last update(). */
  readonly cue: CueDisplay;
  /** Feed one landmark frame. Returns a result once the challenge finishes by itself. */
  update(m: FaceMetrics): ChallengeResult | null;
  /** Result for a timeout or skip. Keeps any partial credit already earned. */
  incomplete(reason: "timeout" | "skipped"): ChallengeResult;
  /** Logs challenge_end once and returns the result tagged with the challenge id. */
  end(result: ChallengeResult, now: number, extra?: ClientEvent["payload"]): ChallengeResult;
  /** Events not yet handed out, in order. */
  takeEvents(): ClientEvent[];
  /** Every event logged so far. */
  readonly events: readonly ClientEvent[];
}

const STALE_MS = 1200;

abstract class BaseTracker<C extends Challenge> implements ChallengeTracker {
  readonly challenge: C;
  readonly events: ClientEvent[] = [];
  protected readonly startedAt: number;
  protected validFrames = 0;
  protected finished = false;
  private readonly origin: number;
  private handedOut = 0;
  private ended = false;

  /** startedAt and frame timestamps share the performance.now() timebase; origin converts them to epoch ms. */
  constructor(challenge: C, startedAt: number, origin: number) {
    this.challenge = challenge;
    this.startedAt = startedAt;
    this.origin = origin;
    this.log("challenge_start", startedAt, { kind: challenge.kind });
  }

  abstract readonly progress: string;
  abstract readonly cue: CueDisplay;
  abstract update(m: FaceMetrics): ChallengeResult | null;
  abstract incomplete(reason: "timeout" | "skipped"): ChallengeResult;
  protected endPayload(): ClientEvent["payload"] { return {}; }

  protected epoch(t: number): number {
    return Math.round(this.origin + t);
  }

  protected log(type: EventType, t: number, payload: ClientEvent["payload"] = {}): void {
    this.events.push({ challenge_id: this.challenge.id, type, client_ts_ms: this.epoch(t), payload });
  }

  end(result: ChallengeResult, now: number, extra: ClientEvent["payload"] = {}): ChallengeResult {
    this.finished = true;
    const final = { ...result, id: this.challenge.id };
    if (!this.ended) {
      this.ended = true;
      this.log("challenge_end", now, { status: final.status, risk: final.risk, ...this.endPayload(), ...extra });
    }
    return final;
  }

  takeEvents(): ClientEvent[] {
    const out = this.events.slice(this.handedOut);
    this.handedOut = this.events.length;
    return out;
  }
}

// ---------- head_sequence ----------

export const HEAD = {
  calibrationFrames: 8,
  calibrationMaxAbsYawDeg: 12,
  calibrationMaxRangeDeg: 8,
  calibrationMaxPitchRollRangeDeg: 10,
  maxRollDeg: 25,
  yawThresholdDeg: 15,
  pitchThresholdDeg: 12,
  onsetDeg: 5,
  centerDeg: 6,
  /** The axis NOT being prompted only has to be roughly level to count as "returned". */
  centerOffAxisDeg: 12,
  holdFrames: 3,
  returnFrames: 2,
  wrongFrames: 2
} as const;

const threshold = (move: HeadMove) =>
  MOVE_AXIS[move].axis === "yaw" ? HEAD.yawThresholdDeg : HEAD.pitchThresholdDeg;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

const range = (values: number[]) => Math.max(...values) - Math.min(...values);

/** 3/3 -> 10, 2/3 -> 40, otherwise no usable evidence. Two or more wrong-direction moves -> 70. */
export function headSequenceRisk(completed: number, total: number, wrong: number): number | null {
  if (wrong >= 2) return 70;
  if (total > 0 && completed >= total) return 10;
  if (total > 1 && completed === total - 1) return 40;
  return null;
}

export class HeadSequenceTracker extends BaseTracker<Extract<Challenge, { kind: "head_sequence" }>> {
  private calibration = { yaw: [] as number[], pitch: [] as number[], roll: [] as number[] };
  private neutral: { yaw: number; pitch: number; roll: number } | null = null;

  private step = 0;
  private phase: "turn" | "return" | "rearm" = "turn";
  private cueAt: number | null = null;
  private onsetAt: number | null = null;
  private returnStart: number | null = null;
  private hold = 0;
  private wrongHold = 0;
  private wrongMove: HeadMove | null = null;
  private centerHold = 0;
  private lastValid = -Infinity;

  private done: { move: HeadMove; cue: number; onset: number; done: number }[] = [];
  private wrong = 0;

  get progress(): string {
    if (!this.neutral) return "Look straight ahead to calibrate";
    const move = this.challenge.moves[this.step];
    const of = `Move ${this.step + 1} of ${this.challenge.moves.length}`;
    if (this.phase === "return") return `${of}: good. Now return to center`;
    if (this.phase === "rearm") return "Wrong direction. Return to center, then follow the arrow";
    return `${of}: ${MOVE_WORDS[move]}`;
  }

  get cue(): CueDisplay {
    if (this.finished) return null;
    if (!this.neutral || this.phase === "return") return { type: "center" };
    return {
      type: "arrow",
      move: this.challenge.moves[this.step],
      step: this.step,
      total: this.challenge.moves.length,
      wrong: this.phase === "rearm"
    };
  }

  private resetHolds(): void {
    this.hold = 0;
    this.wrongHold = 0;
    this.wrongMove = null;
    this.centerHold = 0;
    this.returnStart = null;
  }

  private resetCalibration(): void {
    this.calibration = { yaw: [], pitch: [], roll: [] };
    this.neutral = null;
  }

  private issueCue(t: number): void {
    this.cueAt = t;
    this.onsetAt = null;
    this.phase = "turn";
    this.resetHolds();
    this.log("cue", t, { index: this.step, move: this.challenge.moves[this.step] });
  }

  update(m: FaceMetrics): ChallengeResult | null {
    if (this.finished) return null;

    const { yawDeg: yaw, pitchDeg: pitch, rollDeg: roll } = m;
    if (
      m.faceCount !== 1 ||
      yaw === undefined || pitch === undefined || roll === undefined ||
      !Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(roll)
    ) {
      this.resetHolds();
      if (!this.neutral) this.resetCalibration();
      return null;
    }

    // After a tracking gap the head may have moved: recalibrate, keep completed moves.
    if (m.timestamp - this.lastValid > STALE_MS) {
      this.resetHolds();
      this.resetCalibration();
    }
    this.lastValid = m.timestamp;
    this.validFrames++;

    if (!this.neutral) {
      this.calibrate(m.timestamp, yaw, pitch, roll);
      return null;
    }

    const yawDelta = yaw - this.neutral.yaw;
    const pitchDelta = pitch - this.neutral.pitch;

    if (Math.abs(roll - this.neutral.roll) > HEAD.maxRollDeg) {
      this.resetHolds();
      return null;
    }

    const target = this.challenge.moves[this.step];

    if (this.phase === "rearm") {
      if (this.centered(this.wrongMove ?? target, yawDelta, pitchDelta)) {
        if (++this.centerHold >= HEAD.returnFrames) {
          this.phase = "turn";
          this.onsetAt = null;
          this.resetHolds();
        }
      } else {
        this.centerHold = 0;
      }
      return null;
    }

    if (this.phase === "return") {
      if (this.centered(target, yawDelta, pitchDelta)) {
        this.returnStart ??= m.timestamp;
        if (++this.centerHold >= HEAD.returnFrames) return this.completeMove(target, this.returnStart);
      } else {
        this.centerHold = 0;
        this.returnStart = null;
      }
      return null;
    }

    // phase === "turn"
    if (this.onsetAt === null && deflection(target, yawDelta, pitchDelta) > HEAD.onsetDeg) {
      this.onsetAt = m.timestamp;
    }

    // The dominant direction decides, so pitch drift during a yaw turn is not a "wrong" move.
    let best: HeadMove = target;
    let bestRatio = -Infinity;
    for (const move of MOVES) {
      const ratio = deflection(move, yawDelta, pitchDelta) / threshold(move);
      if (ratio > bestRatio) { best = move; bestRatio = ratio; }
    }

    if (bestRatio >= 1 && best === target) {
      this.wrongHold = 0;
      this.wrongMove = null;
      if (++this.hold >= HEAD.holdFrames) {
        this.phase = "return";
        this.hold = 0;
        this.centerHold = 0;
        this.returnStart = null;
      }
      return null;
    }

    this.hold = 0;

    if (bestRatio >= 1) {
      this.wrongHold = this.wrongMove === best ? this.wrongHold + 1 : 1;
      this.wrongMove = best;
      if (this.wrongHold >= HEAD.wrongFrames) {
        this.wrong++;
        this.phase = "rearm";
        this.onsetAt = null;
        this.hold = 0;
        this.wrongHold = 0;
        this.centerHold = 0;
      }
    } else {
      this.wrongHold = 0;
      this.wrongMove = null;
    }

    return null;
  }

  private centered(move: HeadMove, yawDelta: number, pitchDelta: number): boolean {
    const yawLimit = MOVE_AXIS[move].axis === "yaw" ? HEAD.centerDeg : HEAD.centerOffAxisDeg;
    const pitchLimit = MOVE_AXIS[move].axis === "pitch" ? HEAD.centerDeg : HEAD.centerOffAxisDeg;
    return Math.abs(yawDelta) <= yawLimit && Math.abs(pitchDelta) <= pitchLimit;
  }

  private calibrate(t: number, yaw: number, pitch: number, roll: number): void {
    if (Math.abs(yaw) > HEAD.calibrationMaxAbsYawDeg || Math.abs(roll) > HEAD.maxRollDeg) {
      this.resetCalibration();
      return;
    }

    const c = this.calibration;
    c.yaw.push(yaw);
    c.pitch.push(pitch);
    c.roll.push(roll);

    if (
      range(c.yaw) > HEAD.calibrationMaxRangeDeg ||
      range(c.pitch) > HEAD.calibrationMaxPitchRollRangeDeg ||
      range(c.roll) > HEAD.calibrationMaxPitchRollRangeDeg
    ) {
      this.resetCalibration();
      return;
    }

    if (c.yaw.length >= HEAD.calibrationFrames) {
      this.neutral = { yaw: median(c.yaw), pitch: median(c.pitch), roll: median(c.roll) };
      // The first arrow appears once; a recalibration later keeps the current step's cue.
      if (this.cueAt === null) this.issueCue(t);
    }
  }

  private completeMove(move: HeadMove, doneAt: number): ChallengeResult | null {
    const cue = this.cueAt ?? doneAt;
    const onset = this.onsetAt ?? doneAt;
    this.done.push({ move, cue, onset, done: doneAt });
    this.log("response", onset, {
      index: this.step,
      move,
      cue_ts_ms: this.epoch(cue),
      onset_ts_ms: this.epoch(onset),
      done_ts_ms: this.epoch(doneAt),
      latency_ms: Math.round(onset - cue)
    });

    this.step++;
    if (this.step >= this.challenge.moves.length) {
      this.finished = true;
      return this.result();
    }

    this.issueCue(doneAt);
    return null;
  }

  private timings(): MoveTiming[] {
    return this.done.map(d => ({
      move: d.move,
      cue_ts: this.epoch(d.cue),
      onset_ts: this.epoch(d.onset),
      done_ts: this.epoch(d.done)
    }));
  }

  private result(reason?: "timeout" | "skipped"): ChallengeResult {
    const total = this.challenge.moves.length;
    const completed = this.done.length;
    const risk = headSequenceRisk(completed, total, this.wrong);
    const status: ChallengeResult["status"] =
      completed >= total ? "observed" : risk !== null ? "partial" : "unavailable";

    const followed = this.done.map(d => d.move).join(", ");
    const latencies = this.done.map(d => Math.round(d.onset - d.cue));
    const wrongText = `${this.wrong} wrong-direction move${this.wrong === 1 ? "" : "s"}`;

    let detail: string;
    if (completed >= total) {
      detail = `Followed all ${total} head moves in order (${followed}); reaction ${Math.min(...latencies)}-${Math.max(...latencies)} ms; ${wrongText}.`;
    } else if (completed > 0) {
      detail = `${completed}/${total} head moves followed (${followed}) before the ${reason ?? "end"}; ${wrongText}.`;
    } else if (this.validFrames) {
      detail = `No head move was completed before the ${reason ?? "end"}; ${wrongText}. This may be a capability, accessibility, or lighting issue, not fraud.`;
    } else {
      detail = "No usable single-face evidence. Missing evidence is not a pass.";
    }

    return {
      kind: "head_sequence",
      status,
      risk,
      detail: detail + " Experimental MediaPipe pose heuristic; not proof of identity.",
      moves: this.timings(),
      movesTotal: total,
      wrongDirection: this.wrong
    };
  }

  incomplete(reason: "timeout" | "skipped"): ChallengeResult {
    return this.result(reason);
  }

  protected endPayload(): ClientEvent["payload"] {
    return { moves_completed: this.done.length, moves_total: this.challenge.moves.length, wrong_direction: this.wrong };
  }
}

// ---------- cued_blink ----------

export const BLINK = {
  settleMs: 1000,
  windowMinMs: 150,
  windowMaxMs: 1500,
  ringMs: 500,
  closed: 0.55,
  open: 0.3,
  maxClosedMs: 1400,
  pass: 2
} as const;

export class CuedBlinkTracker extends BaseTracker<Extract<Challenge, { kind: "cued_blink" }>> {
  private readonly schedule: number[];
  private readonly fired: (number | null)[];
  private readonly matched: (number | null)[];
  private openSeen = false;
  private closedAt: number | null = null;
  private lastValid = -Infinity;
  private early = 0;
  private now = -Infinity;

  constructor(challenge: Extract<Challenge, { kind: "cued_blink" }>, startedAt: number, origin: number) {
    super(challenge, startedAt, origin);
    const offsets = [...challenge.cue_offsets_ms].sort((a, b) => a - b);
    this.schedule = offsets.map(offset => startedAt + BLINK.settleMs + offset);
    this.fired = offsets.map(() => null);
    this.matched = offsets.map(() => null);
  }

  private get matchedCount(): number {
    return this.matched.filter(v => v !== null).length;
  }

  get progress(): string {
    const total = this.schedule.length;
    if (this.fired.every(v => v === null)) return "Keep your eyes open and watch for the ring";
    return `${this.matchedCount}/${total} cues answered. Blink once each time the ring flashes`;
  }

  get cue(): CueDisplay {
    if (this.finished) return null;
    for (let i = this.fired.length - 1; i >= 0; i--) {
      const at = this.fired[i];
      if (at !== null && this.now - at < BLINK.ringMs) return { type: "ring", index: i };
    }
    return null;
  }

  update(m: FaceMetrics): ChallengeResult | null {
    if (this.finished) return null;
    const t = m.timestamp;
    this.now = t;

    // Cues fire on the frame that reaches their time; that frame time is what gets logged.
    this.schedule.forEach((due, i) => {
      if (this.fired[i] === null && t >= due) {
        this.fired[i] = t;
        this.log("cue", t, { index: i });
      }
    });

    if (m.faceCount !== 1 || t - this.lastValid > STALE_MS) {
      this.openSeen = false;
      this.closedAt = null;
    }

    if (m.faceCount === 1) {
      this.lastValid = t;
      this.validFrames++;

      const closed = m.blinkLeft > BLINK.closed && m.blinkRight > BLINK.closed;
      const open = m.blinkLeft < BLINK.open && m.blinkRight < BLINK.open;

      if (open) {
        if (this.openSeen && this.closedAt !== null && t - this.closedAt <= BLINK.maxClosedMs) {
          this.registerBlink(this.closedAt);
        }
        this.openSeen = true;
        this.closedAt = null;
      } else if (closed && this.openSeen && this.closedAt === null) {
        this.closedAt = t;
      }
    }

    const total = this.schedule.length;
    const last = this.fired[total - 1];
    const windowsOver = last !== null && last !== undefined && t - last > BLINK.windowMaxMs &&
      (this.closedAt === null || t - this.closedAt > BLINK.maxClosedMs);

    if (this.matchedCount >= total || windowsOver) {
      this.finished = true;
      return this.result();
    }
    return null;
  }

  /** A blink counts for the latest unanswered cue it started 150-1500 ms after. Others are ignored. */
  private registerBlink(start: number): void {
    let best = -1;
    for (let i = 0; i < this.fired.length; i++) {
      const at = this.fired[i];
      if (at === null || this.matched[i] !== null) continue;
      const latency = start - at;
      if (latency >= BLINK.windowMinMs && latency <= BLINK.windowMaxMs) best = i;
    }

    if (best >= 0) {
      this.matched[best] = start;
      this.log("response", start, { index: best, latency_ms: Math.round(start - this.fired[best]!) });
      return;
    }

    if (this.fired.some(at => at !== null && start - at >= 0 && start - at < BLINK.windowMinMs)) this.early++;
  }

  private timings(): BlinkTiming[] {
    const out: BlinkTiming[] = [];
    this.fired.forEach((at, i) => {
      const blink = this.matched[i];
      if (at !== null && blink !== null) {
        out.push({ cue_ts: this.epoch(at), blink_ts: this.epoch(blink), latency: Math.round(blink - at) });
      }
    });
    return out;
  }

  private result(reason?: "timeout" | "skipped"): ChallengeResult {
    const total = this.schedule.length;
    const blinks = this.timings();
    const passed = blinks.length >= BLINK.pass;
    const latencies = blinks.map(b => `${b.latency}`).join(", ");
    const early = this.early ? ` ${this.early} blink${this.early === 1 ? "" : "s"} came under 150 ms after a cue and were not counted.` : "";

    const detail = passed
      ? `${blinks.length}/${total} ring cues answered by a blink 150-1500 ms later (latencies ${latencies} ms).${early}`
      : this.validFrames
        ? `Only ${blinks.length}/${total} ring cues were answered in time${reason ? ` before the ${reason}` : ""}; at least ${BLINK.pass} are needed.${early} This may be a capability, accessibility, or lighting issue, not fraud.`
        : "No usable single-face evidence. Missing evidence is not a pass.";

    return {
      kind: "cued_blink",
      status: passed ? "observed" : "unavailable",
      risk: passed ? 10 : null,
      detail: detail + " Not certified liveness.",
      blinks,
      cuesTotal: total
    };
  }

  incomplete(reason: "timeout" | "skipped"): ChallengeResult {
    return this.result(reason);
  }

  protected endPayload(): ClientEvent["payload"] {
    return { cues_matched: this.matchedCount, cues_total: this.schedule.length, early_blinks: this.early };
  }
}

// ---------- digits (mouth motion; speech is handled in lib/speech.ts) ----------

export class DigitsTracker extends BaseTracker<Extract<Challenge, { kind: "digits" }>> {
  private openSeen = false;
  private closedAt: number | null = null;
  private lastCycle = -Infinity;
  private lastValid = -Infinity;
  private cycles = 0;

  get progress(): string {
    return `${this.cycles}/2 mouth movements observed`;
  }

  get cue(): CueDisplay {
    return null;
  }

  update(m: FaceMetrics): ChallengeResult | null {
    if (this.finished) return null;

    if (m.faceCount !== 1) {
      this.openSeen = false;
      this.closedAt = null;
      this.cycles = 0;
      this.lastCycle = -Infinity;
      this.lastValid = -Infinity;
      return null;
    }

    if (m.timestamp - this.lastValid > STALE_MS) {
      this.closedAt = null;
      this.openSeen = false;
    }
    this.lastValid = m.timestamp;
    this.validFrames++;

    const isClosed = m.jawOpen > 0.22;
    const isOpen = m.jawOpen < 0.12;

    if (isOpen) {
      if (this.openSeen && this.closedAt !== null) {
        const duration = m.timestamp - this.closedAt;
        if (duration >= 70 && duration <= 1400 && m.timestamp - this.lastCycle > 180) {
          this.cycles++;
          this.lastCycle = m.timestamp;
        }
      }
      this.openSeen = true;
      this.closedAt = null;
    } else if (isClosed && this.openSeen && this.closedAt === null) {
      this.closedAt = m.timestamp;
    }

    if (this.cycles >= 2) {
      this.finished = true;
      return {
        kind: "digits",
        status: "partial",
        risk: 60,
        detail: "Mouth motion observed; the random digits and audio were NOT verified."
      };
    }

    return null;
  }

  incomplete(): ChallengeResult {
    return {
      kind: "digits",
      status: "unavailable",
      risk: null,
      detail: this.validFrames
        ? "Prompt not completed or skipped. This may be a capability, accessibility, or lighting issue, not fraud."
        : "No usable single-face evidence. Missing evidence is not a pass."
    };
  }

  protected endPayload(): ClientEvent["payload"] {
    return { mouth_cycles: this.cycles };
  }
}

/** startedAt is performance.now()-based like frame timestamps; origin is performance.timeOrigin in the browser. */
export function createTracker(challenge: Challenge, startedAt: number, origin = 0): ChallengeTracker {
  if (challenge.kind === "head_sequence") return new HeadSequenceTracker(challenge, startedAt, origin);
  if (challenge.kind === "cued_blink") return new CuedBlinkTracker(challenge, startedAt, origin);
  return new DigitsTracker(challenge, startedAt, origin);
}

// ------------------------------------------
// LIVENESS SIGNAL
// ------------------------------------------

const MISSING_RISK = 60;
const NOT_FOLLOWING_RISK = 70;

/** Summarises per-challenge results. Each missing challenge costs 60; two or more wrong-direction head moves raise the total to at least 70. */
export function livenessSignal(results: ChallengeResult[]): Signal {
  const head = results.find(r => r.kind === "head_sequence");
  const blink = results.find(r => r.kind === "cued_blink");
  const digits = results.find(r => r.kind === "digits");

  const wrong = head?.wrongDirection ?? 0;
  const notFollowing = wrong >= 2;

  const headRisk = head ? headSequenceRisk(head.moves?.length ?? 0, head.movesTotal ?? 0, 0) : null;
  const blinkRisk = blink && (blink.blinks?.length ?? 0) >= BLINK.pass ? 10 : null;
  const digitsRisk = digits?.risk ?? null;

  if (headRisk === null && blinkRisk === null && digits?.status !== "observed" && !notFollowing) {
    return {
      id: "liveness",
      risk: null,
      provenance: "unavailable",
      detail: "No completed head-sequence, cued-blink, or spoken-digit evidence."
    };
  }

  const parts: string[] = [];

  if (!head) parts.push("Head sequence: not run.");
  else {
    const done = head.moves?.length ?? 0;
    const total = head.movesTotal ?? 0;
    const order = head.moves?.map(m => m.move).join(", ");
    parts.push(
      headRisk === 10 ? `Head sequence: ${done}/${total} moves passed in order (${order}), risk 10.`
        : headRisk === 40 ? `Head sequence: ${done}/${total} moves passed (${order}), risk 40.`
          : `Head sequence: ${done}/${total} moves, unavailable (counts as 60).`
    );
  }

  if (!blink) parts.push("Cued blinks: not run.");
  else {
    const matched = blink.blinks ?? [];
    parts.push(
      blinkRisk !== null
        ? `Cued blinks: ${matched.length}/${blink.cuesTotal ?? 0} cues answered (${matched.map(b => `${b.latency} ms`).join(", ")}), risk 10.`
        : `Cued blinks: ${matched.length}/${blink.cuesTotal ?? 0} cues answered, unavailable (counts as 60).`
    );
  }

  parts.push(
    digits?.status === "observed" && typeof digits.matched === "number"
      ? `Spoken digits: ${digits.matched}/4 recognized on-device, risk ${digits.risk}.`
      : "Spoken digits: content unverified, counts as 60."
  );

  let risk = Math.round(
    [headRisk, blinkRisk, digitsRisk].reduce<number>((sum, value) => sum + (value ?? MISSING_RISK), 0) / 3
  );

  if (notFollowing) {
    risk = Math.max(risk, NOT_FOLLOWING_RISK);
    parts.push(`${wrong} wrong-direction head moves: responses did not follow the live prompts (possible replay), so risk is at least ${NOT_FOLLOWING_RISK}.`);
  }

  return {
    id: "liveness",
    risk,
    provenance: "heuristic",
    detail: parts.join(" ") + " Motion and speech-content heuristics, not proof of liveness or identity."
  };
}
