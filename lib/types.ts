
export type SignalId =
  | "injection"
  | "liveness"
  | "reflection"
  | "pulse"
  | "sync";

export type Provenance =
  | "observed"
  | "heuristic"
  | "server"
  | "simulated"
  | "unavailable";

export type Decision = "approve" | "step-up" | "reject";

export type ScenarioId =
  | "normal"
  | "replay"
  | "virtual"
  | "deepfake";

export interface Signal {
  id: SignalId;
  risk: number | null;
  provenance: Provenance;
  detail: string;
}

export interface DecisionResult {
  decision: Decision;
  risk: number;
  mode: "live" | "simulation";
  coverage: number;
  explanation: string;
  reasons: string[];
  signals: Signal[];
  contributions: {
    id: SignalId;
    weight: number;
    usedRisk: number;
    substituted: boolean;
  }[];

  /** Present only when the backend recomputed and signed this result. */
  server?: ServerCheck;
}

export interface ServerCheck {
  sessionId: string;
  policyVersion: string;
  token: string;
  freshness: {
    risk: number;
    provenance: "server";
    detail: string;
  };
}

export interface DeviceEvidence {
  label: string;
  width: number | null;
  height: number | null;
  declaredFps: number | null;
  observedFps: number | null;
}

export interface Point {
  x: number;
  y: number;
  z?: number;
}

export interface FaceMetrics {
  timestamp: number;
  faceCount: number;

  /** Legacy nose-offset ratio. Still used by the reflection check's "facing the screen" gate. */
  yaw: number;

  /** 3D head pose in degrees, from MediaPipe's facial transformation matrix.
   * Raw camera-frame values: +yaw = the user's LEFT, +pitch = looking DOWN (see lib/head-pose.ts).
   * Undefined when no single face or no matrix is available.
   */
  yawDeg?: number;
  pitchDeg?: number;
  rollDeg?: number;

  blinkLeft: number;
  blinkRight: number;
  jawOpen: number;

  // Inner-lip gap divided by face height.
  mouthOpen: number;
  points: Point[];
}

export type HeadMove = "left" | "right" | "up" | "down";

export type ChallengeKind = "head_sequence" | "cued_blink" | "digits";

/** One prompt of a plan. Same shape as the backend plan (backend/app/plan.py). */
export type Challenge =
  | { id: string; kind: "head_sequence"; moves: HeadMove[] }
  | { id: string; kind: "cued_blink"; cue_offsets_ms: number[] }
  | { id: string; kind: "digits"; digits: string };

export interface Plan {
  challenges: Challenge[];
  pulse_hold_ms: number;
}

export type EventType =
  | "challenge_start"
  | "cue"
  | "response"
  | "challenge_end"
  | "pulse_result";

/** A timed event for server-side checking. client_ts_ms is epoch ms (performance.timeOrigin + performance.now()). */
export interface ClientEvent {
  challenge_id: string;
  type: EventType;
  client_ts_ms: number;
  payload: Record<string, number | string | boolean | null>;
}

/** Per-move timings of a head sequence, epoch ms. onset = first frame beyond 5 degrees in the right direction. */
export interface MoveTiming {
  move: HeadMove;
  cue_ts: number;
  onset_ts: number;
  done_ts: number;
}

/** A blink matched to a cue, epoch ms. latency = blink_ts - cue_ts. */
export interface BlinkTiming {
  cue_ts: number;
  blink_ts: number;
  latency: number;
}

export interface ChallengeResult {
  kind: ChallengeKind;
  /** Plan challenge id; set when the tracker finalizes the result. */
  id?: string;
  status: "observed" | "partial" | "unavailable";
  detail: string;
  risk: number | null;

  // digits
  heard?: string;
  matched?: number;

  // head_sequence
  moves?: MoveTiming[];
  movesTotal?: number;
  wrongDirection?: number;

  // cued_blink
  blinks?: BlinkTiming[];
  cuesTotal?: number;
}
