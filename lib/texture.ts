import type * as Ort from "onnxruntime-web";

/** Silent-Face MiniFASNet models (Apache-2.0, see THIRD_PARTY.md). Converted to ONNX with a softmax head:
 * input "input" [1,3,80,80] float32, BGR, raw 0..255; output "probs" [1,3]; index 1 = real face.
 */
export const TEXTURE_MODELS = [
  { url: "/models/silent-face/2.7_80x80_MiniFASNetV2.onnx", scale: 2.7 },
  { url: "/models/silent-face/4_0_0_80x80_MiniFASNetV1SE.onnx", scale: 4.0 },
] as const;
const SIZE = 80;
export const TEXTURE = { minScores: 6, realHigh: 0.7, realLow: 0.4 } as const;

let loading: Promise<Ort.InferenceSession[]> | null = null;
let sessions: Ort.InferenceSession[] | null = null;
let canvas: OffscreenCanvas | null = null;

/** Lazily creates and caches both sessions. A failed load stays cached: no retry storm every 500 ms. */
export function loadTextureModels(): Promise<void> {
  loading ??= (async () => {
    const ort = await import("onnxruntime-web");
    ort.env.wasm.wasmPaths = "/ort/";
    ort.env.wasm.numThreads = 1; // the page is not cross-origin isolated
    const created = await Promise.all(TEXTURE_MODELS.map(m => ort.InferenceSession.create(m.url, { executionProviders: ["wasm"] })));
    sessions = created;
    return created;
  })();
  return loading.then(() => undefined);
}

/** Landmark extents in pixels as [x, y, w, h]; null for an empty or degenerate set. */
export function landmarkBox(points: { x: number; y: number }[], width: number, height: number): [number, number, number, number] | null {
  if (points.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x * width); x1 = Math.max(x1, p.x * width);
    y0 = Math.min(y0, p.y * height); y1 = Math.max(y1, p.y * height);
  }
  const w = x1 - x0, h = y1 - y0;
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? [x0, y0, w, h] : null;
}

/** Port of Silent-Face CropImage._get_new_box: scale the box about its centre, capped by the frame,
 * then SHIFT it back inside the frame (never shrink). Returns inclusive [x1, y1, x2, y2] like upstream,
 * truncated with int() as upstream does; the crop is (x2 - x1 + 1) by (y2 - y1 + 1) pixels.
 */
export function cropBox(srcW: number, srcH: number, bbox: [number, number, number, number], scale: number): [number, number, number, number] {
  const [x, y, boxW, boxH] = bbox;
  scale = Math.min((srcH - 1) / boxH, Math.min((srcW - 1) / boxW, scale));
  const newW = boxW * scale, newH = boxH * scale;
  const cx = boxW / 2 + x, cy = boxH / 2 + y;
  let left = cx - newW / 2, top = cy - newH / 2, right = cx + newW / 2, bottom = cy + newH / 2;
  if (left < 0) { right -= left; left = 0; }
  if (top < 0) { bottom -= top; top = 0; }
  if (right > srcW - 1) { left -= right - srcW + 1; right = srcW - 1; }
  if (bottom > srcH - 1) { top -= bottom - srcH + 1; bottom = srcH - 1; }
  return [Math.trunc(left), Math.trunc(top), Math.trunc(right), Math.trunc(bottom)];
}

/** Crops and resizes to 80x80, then packs CHW, BGR, raw 0..255 (no /255, no mean/std, as upstream). */
function cropTensor(ctx: OffscreenCanvasRenderingContext2D, video: HTMLVideoElement, box: [number, number, number, number]): Float32Array {
  const [x1, y1, x2, y2] = box;
  ctx.drawImage(video, x1, y1, x2 - x1 + 1, y2 - y1 + 1, 0, 0, SIZE, SIZE);
  const rgba = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const plane = SIZE * SIZE;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = rgba[i * 4 + 2];
    out[plane + i] = rgba[i * 4 + 1];
    out[2 * plane + i] = rgba[i * 4];
  }
  return out;
}

/** Real-face probability in 0..1, averaged over both models; null when no score could be made.
 * Frames are drawn to an in-memory canvas and discarded; nothing is stored or uploaded.
 */
export async function scoreFrame(video: HTMLVideoElement, landmarks: { x: number; y: number }[]): Promise<number | null> {
  const width = video.videoWidth, height = video.videoHeight;
  const bbox = landmarkBox(landmarks, width, height);
  if (!bbox || typeof OffscreenCanvas === "undefined") return null;
  canvas ??= new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  // Crop before the first await, so the pixels belong to the frame the landmarks came from.
  const inputs = TEXTURE_MODELS.map(m => cropTensor(ctx, video, cropBox(width, height, bbox, m.scale)));
  try {
    await loadTextureModels();
    const ort = await import("onnxruntime-web");
    let real = 0;
    for (let i = 0; i < inputs.length; i++) {
      const output = await sessions![i].run({ input: new ort.Tensor("float32", inputs[i], [1, 3, SIZE, SIZE]) });
      const probs = output.probs.data as Float32Array;
      real += probs[1];
    }
    const score = real / inputs.length;
    return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null;
  } catch {
    return null;
  }
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Thresholds are STARTING POINTS from the task brief, not measured operating points. */
export function analyzeTexture(scores: number[]): { risk: number | null; detail: string } {
  const m = median(scores);
  if (m === null || scores.length < TEXTURE.minScores) return { risk: null, detail: "Insufficient frames" };
  const risk = m >= TEXTURE.realHigh ? 15 : m >= TEXTURE.realLow ? 45 : 80;
  return { risk, detail: `Experimental texture check: median real-face score ${m.toFixed(2)}. Not validated.` };
}
