/// <reference lib="webworker" />
// On-device digit transcription. Runs in a Web Worker so inference never blocks the camera loop.
// Everything is loaded from THIS origin: the model from /models/whisper/ and the ONNX runtime from /ort/
// (both prepared by scripts/prepare-assets.mjs). Remote model loading is disabled, so CSP connect-src 'self' holds.
// Do NOT replace this with the Web Speech API: Chrome sends that audio to a cloud service.
import { env, pipeline } from "@huggingface/transformers";

export type AsrRequest = { type: "load" } | { type: "transcribe"; pcm: Float32Array };
export type AsrResponse =
  | { type: "progress"; percent: number }
  | { type: "ready" }
  | { type: "result"; text: string }
  | { type: "error"; message: string };

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = "/models/";
env.useBrowserCache = false; // rely on the ordinary HTTP cache; write nothing to CacheStorage
const wasm = env.backends.onnx.wasm!;
wasm.wasmPaths = "/ort/";
wasm.numThreads = 1; // multi-threading needs cross-origin isolation, which this site does not enable

type Transcriber = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let loading: Promise<Transcriber> | null = null;
const send = (message: AsrResponse) => (self as DedicatedWorkerGlobalScope).postMessage(message);

function load(): Promise<Transcriber> {
  if (!loading) {
    const sizes = new Map<string, { loaded: number; total: number }>();
    loading = (pipeline as unknown as (task: string, model: string, options: Record<string, unknown>) => Promise<Transcriber>)(
      "automatic-speech-recognition", "whisper", {
        dtype: "q8", device: "wasm",
        progress_callback: (item: { status: string; file?: string; loaded?: number; total?: number }) => {
          if (item.status !== "progress" || !item.file || !item.total) return;
          sizes.set(item.file, { loaded: item.loaded ?? 0, total: item.total });
          let loaded = 0, total = 0;
          for (const size of sizes.values()) { loaded += size.loaded; total += size.total; }
          send({ type: "progress", percent: Math.min(99, Math.round(loaded * 100 / total)) });
        },
      });
    loading.catch(() => { loading = null; });
  }
  return loading;
}

self.onmessage = async (event: MessageEvent<AsrRequest>) => {
  try {
    const transcriber = await load();
    if (event.data.type === "load") { send({ type: "ready" }); return; }
    // Four digits need very few tokens; the cap also bounds a hallucinated run on noise.
    const output = await transcriber(event.data.pcm, { max_new_tokens: 32 });
    send({ type: "result", text: (Array.isArray(output) ? output[0]?.text : output.text) ?? "" });
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : "Speech model failed." });
  }
};
