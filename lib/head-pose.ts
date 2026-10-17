
export interface HeadPose {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

/**
 * Extract Euler angles from MediaPipe's 4x4
 * column-major facial transformation matrix.
 *
 * Signs must be calibrated against the physical
 * webcam and mirrored preview.
 */
export function extractHeadPose(
  data: ArrayLike<number>
): HeadPose | null {
  if (data.length !== 16) return null;

  const m = Array.from(data);

  if (!m.every(Number.isFinite)) return null;

  // Rotation portion of the column-major matrix.
  const r00 = m[0];
  const r10 = m[1];
  const r20 = m[2];

  const r11 = m[5];
  const r12 = m[9];
  const r21 = m[6];
  const r22 = m[10];

  const yaw = Math.atan2(
    -r20,
    Math.sqrt(r00 * r00 + r10 * r10)
  );

  const pitch = Math.atan2(r21, r22);
  const roll = Math.atan2(r10, r00);

  return {
    yawDeg: yaw * 180 / Math.PI,
    pitchDeg: pitch * 180 / Math.PI,
    rollDeg: roll * 180 / Math.PI
  };
}
