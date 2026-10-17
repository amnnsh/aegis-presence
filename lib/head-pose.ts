import type { HeadMove } from "./types.ts";

export interface HeadPose {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

/**
 * Extract Z-Y-X Euler angles (degrees) from MediaPipe's 4x4 column-major
 * facial transformation matrix (data[col * 4 + row]).
 *
 * MediaPipe's metric space is right-handed: +X = image right of the UNMIRRORED
 * camera frame, +Y = up, +Z = toward the camera. The canonical face looks along +Z.
 * With R = Rz(roll) * Ry(yaw) * Rx(pitch):
 *   +yaw   = nose rotates toward +X  = the user's LEFT
 *   +pitch = nose rotates toward -Y  = the user looks DOWN
 * Scale-invariant, so a similarity transform gives the same angles.
 */
export function extractHeadPose(
  data: ArrayLike<number>
): HeadPose | null {
  if (data.length !== 16) return null;

  const m = Array.from(data);

  if (!m.every(Number.isFinite)) return null;

  const r00 = m[0];
  const r10 = m[1];
  const r20 = m[2];
  const r21 = m[6];
  const r22 = m[10];

  const yaw = Math.atan2(-r20, Math.hypot(r00, r10));
  const pitch = Math.atan2(r21, r22);
  const roll = Math.atan2(r10, r00);

  return {
    yawDeg: yaw * 180 / Math.PI,
    pitchDeg: pitch * 180 / Math.PI,
    rollDeg: roll * 180 / Math.PI
  };
}

/**
 * The ONE place that maps a prompted move onto a pose axis and sign.
 * "left" means the user's own left, which is also screen-left in the
 * mirrored (scaleX(-1)) preview. Confirm on a real camera with ?debug=1.
 * Empirically confirmed for yaw in 5f8e9f0 (left = positive yaw).
 */
export const MOVE_AXIS: Record<HeadMove, { axis: "yaw" | "pitch"; sign: 1 | -1 }> = {
  left: { axis: "yaw", sign: 1 },
  right: { axis: "yaw", sign: -1 },
  up: { axis: "pitch", sign: -1 },
  down: { axis: "pitch", sign: 1 }
};

export const MOVES: HeadMove[] = ["left", "right", "up", "down"];

/** Signed deflection toward `move`, in degrees, from yaw/pitch deltas. */
export function deflection(move: HeadMove, yawDelta: number, pitchDelta: number): number {
  const { axis, sign } = MOVE_AXIS[move];
  return (axis === "yaw" ? yawDelta : pitchDelta) * sign;
}

/** Human-readable reading for the ?debug=1 overlay. */
export function describePose(yawDeg: number, pitchDeg: number, deadband = 5): string {
  const name = (value: number, axis: "yaw" | "pitch") => {
    if (Math.abs(value) < deadband) return "center";
    const move = MOVES.find(m => MOVE_AXIS[m].axis === axis && Math.sign(value) === MOVE_AXIS[m].sign)!;
    return `user's ${move.toUpperCase()}`;
  };
  const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}°`;
  return `yaw ${fmt(yawDeg)} (${name(yawDeg, "yaw")})  pitch ${fmt(pitchDeg)} (${name(pitchDeg, "pitch")})`;
}
