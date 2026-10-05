import type { Challenge, ChallengeResult, FaceMetrics, Signal } from "./types.ts";

export function randomInt(max: number): number {
  if (!Number.isSafeInteger(max) || max < 1 || max > 0x100000000) throw new Error("Invalid random range");
  const limit = Math.floor(0x100000000 / max) * max;
  const data = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(data); } while (data[0] >= limit);
  return data[0] % max;
}
export function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
export function createChallenges(): Challenge[] {
  return shuffle<Challenge>([
    { kind: "head", direction: randomInt(2) ? "left" : "right" },
    { kind: "blink" },
    { kind: "digits", digits: Array.from({ length: 4 }, () => randomInt(10)).join("") },
  ]);
}
export function challengeTitle(c: Challenge): string {
  if (c.kind === "head") return `Turn ${c.direction}, then face forward`;
  if (c.kind === "blink") return "Blink twice, naturally";
  return `Read ${c.digits?.split("").join(" ")} aloud`;
}
export function challengeHint(c: Challenge): string {
  if (c.kind === "head") return `Look straight ahead first. Then move your nose toward the ${c.direction} edge of the mirrored preview and return to center.`;
  if (c.kind === "blink") return "Keep both eyes visible. Fully open your eyes between each blink.";
  return "Only mouth movement is observed. The digits and your voice are NOT recognized or verified. No microphone is used.";
}

/** Stateful, per-challenge gesture heuristics. Resets on face loss/multiple faces. */
export class GestureTracker {
  private baseline: number[] = [];
  private turned = false;
  private stable = 0;
  private openSeen = false;
  private closedAt: number | null = null;
  private lastCycle = -Infinity;
  private cycles = 0;
  private lastValid = -Infinity;
  private validFrames = 0;
  private completed = false;
  private challenge: Challenge;
  constructor(challenge: Challenge) { this.challenge = challenge; }
  get progress(): string {
    if (this.challenge.kind === "head") return this.baseline.length < 8 ? "Center your face to calibrate" : this.turned ? "Now return to center" : "Follow the arrow, then return";
    return this.challenge.kind === "blink" ? `${this.cycles}/2 blinks observed` : `${this.cycles}/2 mouth movements observed`;
  }
  update(m: FaceMetrics): ChallengeResult | null {
    if (this.completed) return null;
    if (m.faceCount !== 1) {
      this.baseline = []; this.turned = false; this.stable = 0;
      this.openSeen = false; this.closedAt = null; this.cycles = 0;
      this.lastValid = -Infinity;
      return null;
    }
    // A stale frame cannot complete a challenge after a suspended tab or detector stall.
    if (m.timestamp - this.lastValid > 1200) {
      this.closedAt = null; this.openSeen = false; this.stable = 0;
    }
    this.lastValid = m.timestamp;
    this.validFrames++;
    if (this.challenge.kind === "head") {
      if (this.baseline.length < 8) { this.baseline.push(m.yaw); return null; }
      const center = this.baseline.reduce((a, b) => a + b, 0) / this.baseline.length;
      const delta = m.yaw - center;
      const target = this.challenge.direction === "left" ? -1 : 1;
      const matches = this.turned ? Math.abs(delta) < 0.07 : delta * target > 0.13;
      this.stable = matches ? this.stable + 1 : 0;
      if (this.stable >= 3) {
        if (!this.turned) { this.turned = true; this.stable = 0; }
        else { this.completed = true; return { kind: "head", status: "observed", risk: 10, detail: "Relative head offset followed the prompt and returned to center; unvalidated landmark heuristic." }; }
      }
    } else {
      const blinking = this.challenge.kind === "blink";
      const isClosed = blinking ? m.blinkLeft > 0.55 && m.blinkRight > 0.55 : m.jawOpen > 0.22;
      const isOpen = blinking ? m.blinkLeft < 0.3 && m.blinkRight < 0.3 : m.jawOpen < 0.12;
      if (isOpen) {
        if (this.openSeen && this.closedAt !== null) {
          const duration = m.timestamp - this.closedAt;
          if (duration >= 70 && duration <= 1400 && m.timestamp - this.lastCycle > 180) {
            this.cycles++; this.lastCycle = m.timestamp;
          }
        }
        this.openSeen = true; this.closedAt = null;
      } else if (isClosed && this.openSeen && this.closedAt === null) this.closedAt = m.timestamp;
      if (this.cycles >= 2) {
        this.completed = true;
        return blinking
          ? { kind: "blink", status: "observed", risk: 10, detail: "Two bilateral close / reopen cycles observed; not certified liveness." }
          : { kind: "digits", status: "partial", risk: 60, detail: "Mouth motion observed; the random digits and audio were NOT verified." };
      }
    }
    return null;
  }
  unavailable(): ChallengeResult {
    return { kind: this.challenge.kind, status: "unavailable", risk: null,
      detail: this.validFrames ? "Prompt not completed or skipped. This may be a capability, accessibility, or lighting issue, not fraud." : "No usable single-face evidence. Missing evidence is not a pass." };
  }
}
export function livenessSignal(results: ChallengeResult[]): Signal {
  const measured = results.filter(r => r.status === "observed");
  if (measured.length === 0) return { id: "liveness", risk: null, provenance: "unavailable", detail: "No completed head / blink evidence. Speech is not verified." };
  const values = ["head", "blink", "digits"].map(kind => results.find(r => r.kind === kind)?.risk ?? 60);
  return { id: "liveness", risk: Math.round(values.reduce((a, b) => a + b, 0) / 3), provenance: "heuristic",
    detail: `${measured.length}/2 head / blink gestures observed. Digit content is unverified and contributes risk 60. These are motion heuristics, not proof of liveness or identity.` };
}
