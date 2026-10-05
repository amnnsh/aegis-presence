import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, cpSync, writeFileSync, renameSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const required = process.argv.includes("--required");
const model = resolve(root, "public/models/face_landmarker.task");
const url = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
try {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve("@mediapipe/tasks-vision"));
  const wasm = resolve(packageRoot, "wasm");
  if (!existsSync(wasm)) throw new Error("MediaPipe WASM directory not found. Re-run npm install without --ignore-scripts.");
  mkdirSync(resolve(root, "public/mediapipe"), { recursive: true });
  cpSync(wasm, resolve(root, "public/mediapipe/wasm"), { recursive: true });
  mkdirSync(dirname(model), { recursive: true });
  if (!existsSync(model) || statSync(model).size < 1_000_000) {
    console.log("Downloading version-1 Face Landmarker model (build time only; no camera data is involved)...");
    const response = await fetch(url, { signal: AbortSignal.timeout(45000), redirect: "error" });
    if (!response.ok) throw new Error(`Model download returned HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1_000_000 || bytes.length > 30_000_000) throw new Error("Unexpected model length; refusing to use it.");
    writeFileSync(model + ".partial", bytes); renameSync(model + ".partial", model);
  }
  const hash = createHash("sha256").update(readFileSync(model)).digest("hex");
  console.log(`Local model ready. SHA-256: ${hash}`);
  console.log("WASM and model will be served from your own origin. No runtime third-party model downloads.");
} catch (error) {
  console.error(`Asset setup: ${error.message}`);
  console.error("Retry with npm run assets. See DEPLOYMENT.md, step 2, for blocked-download recovery.");
  // Allow installation and the explicitly simulated attack lab; production builds require the assets.
  if (required) process.exitCode = 1;
}
