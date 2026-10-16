export type SignalId = "injection" | "liveness" | "reflection" | "pulse" | "sync";
export type Provenance = "observed" | "heuristic" | "server" | "simulated" | "unavailable";
export type Decision = "approve" | "step-up" | "reject";
export type ScenarioId = "normal" | "replay" | "virtual" | "deepfake";

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
  contributions: { id: SignalId; weight: number; usedRisk: number; substituted: boolean }[];
  /** Present only when the backend recomputed and signed this result. Absent = local only. */
  server?: ServerCheck;
}
/** Freshness is a server-side veto on reported event timing, NOT a weighted signal and NOT camera authentication. */
export interface ServerCheck {
  sessionId: string;
  policyVersion: string;
  token: string;
  freshness: { risk: number; provenance: "server"; detail: string };
}
export interface DeviceEvidence {
  label: string;
  width: number | null;
  height: number | null;
  declaredFps: number | null;
  observedFps: number | null;
}
export interface Point { x: number; y: number; z?: number }
export interface FaceMetrics {
  timestamp: number;
  faceCount: number;
  yaw: number; // Approximate, normalized offset in the MIRRORED preview, not degrees.
  blinkLeft: number;
  blinkRight: number;
  jawOpen: number;
  mouthOpen: number; // Inner-lip gap / face height from landmarks 13, 14, 10, 152. 0 when no single face.
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
  /** Digits prompt with microphone only: digits the on-device speech model heard. Shown to the user, never uploaded. */
  heard?: string;
  matched?: number;
}
