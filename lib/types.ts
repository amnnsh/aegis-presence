export type SignalId = "injection" | "liveness" | "reflection" | "artifacts" | "sync";
export type Provenance = "observed" | "heuristic" | "simulated" | "unavailable";
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
}
