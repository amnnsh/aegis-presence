
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


  yaw: number;

  // New 3D head-pose measurements in degrees.
  // Optional to preserve compatibility with existing code.
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

export type ChallengeKind = "head" | "blink" | "digits";

export interface Challenge {
  kind: ChallengeKind;
  direction?: "left" | "right";
  digits?: string;
}

export interface ChallengeResult {
  kind: ChallengeKind;
  status: "observed" | "partial" | "unavailable";
  detail: string;
  risk: number | null;

  heard?: string;
  matched?: number;
}
