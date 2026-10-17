import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

// Exercise the built production worker, including its bundled runtime and local
// model files. The tiny module harness is served only by Playwright interception.
function productionWorkerUrl() {
  const chunks = resolve("out/_next/static/chunks");
  for (const name of readdirSync(chunks).filter(name => name.endsWith(".js"))) {
    const source = readFileSync(resolve(chunks, name), "utf8");
    if (!source.includes("Loading speech model")) continue;
    const match = source.match(/default\("(static\/chunks\/turbopack-worker-[^"]+)",(\[[^\]]+\])\)/);
    if (!match) continue;
    // Match Turbopack's worker constructor: runtime first, plus the chunk base
    // path used to resolve its dependency promises. An empty base hangs startup.
    const urls = (JSON.parse(match[2]) as string[]).map(path => `/_next/${path}`).reverse();
    return `/_next/${match[1]}#params=${encodeURIComponent(JSON.stringify([urls, "", "/_next/", "", ""]))}`;
  }
  throw new Error("Cannot locate the production speech worker; update the test harness for this bundler output.");
}

test("quiet speech passes through microphone capture and the real speech worker", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  if (testInfo.project.name === "mobile-chromium") test.skip(); // same Chromium worker; avoid loading Whisper twice in parallel
  await page.addInitScript(() => {
    (window as Window & { __aegisWorkerEvents?: unknown[] }).__aegisWorkerEvents = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        const events = (window as Window & { __aegisWorkerEvents?: unknown[] }).__aegisWorkerEvents;
        events?.push({ type: "constructed", url: String(args[0]) });
        this.addEventListener("message", event => {
          events?.push({ type: "message", data: event.data });
          if (events && events.length > 30) events.shift();
        });
        this.addEventListener("error", event => (window as Window & { __aegisWorkerEvents?: unknown[] }).__aegisWorkerEvents?.push({ type: "error", message: event.message, filename: event.filename }));
      }
    };
  });
  page.on("pageerror", error => console.error("Speech test page error:", error.message));
  page.on("console", message => { if (message.type() === "error") console.error("Speech test browser error:", message.text()); });
  const workerUrl = productionWorkerUrl();
  await page.route("**/__speech-test__/lib/*.ts", async route => {
    const file = new URL(route.request().url()).pathname.split("/").pop()!;
    let source = readFileSync(resolve("lib", file), "utf8");
    if (file === "speech.ts") source = source
      .replace('new URL("./asr.worker.ts", import.meta.url)', `new URL(${JSON.stringify(workerUrl)}, location.origin)`)
      .replace('{ type: "module" }', '{}'); // Turbopack's bootstrap uses importScripts.
    await route.fulfill({ contentType: "application/javascript", body: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText });
  });
  await page.route("**/__speech-test__/digits.wav", route => route.fulfill({ contentType: "audio/wav", body: readFileSync(resolve("tests/fixtures/one-two-three-four.wav")) }));
  await page.goto("/verify/");
  await page.getByRole("heading", { level: 1 }).click(); // real user activation for Web Audio
  const outcome = await page.evaluate(async () => {
    // Dynamic paths keep these test-only modules out of the application bundle.
    const base = "/__speech-test__/lib/";
    const { AudioCapture } = await import(base + "audio.ts");
    const { DigitsCheck } = await import(base + "speech.ts");
    const context = new AudioContext();
    await Promise.race([context.resume(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Test audio context did not resume")), 5000))]);
    const buffer = await context.decodeAudioData(await (await fetch("/__speech-test__/digits.wav")).arrayBuffer());
    const samples = buffer.getChannelData(0);
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    for (let i = 0; i < samples.length; i++) samples[i] *= 0.008 / peak;
    const source = context.createBufferSource();
    source.buffer = buffer;
    const destination = context.createMediaStreamDestination();
    source.connect(destination);
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async () => destination.stream;
    const capture = new AudioCapture();
    try {
      await capture.open();
      const check = new DigitsCheck(capture, "1234");
      const ended = new Promise<void>(resolve => { source.onended = () => setTimeout(resolve, 250); });
      source.start(context.currentTime + 0.2);
      await ended;
      const recordedMs = capture.recordedMs;
      const peakLevel = Math.max(...capture.envelope.map((sample: { v: number }) => sample.v));
      const result = await check.finish();
      const workerEvents = (window as Window & { __aegisWorkerEvents?: unknown[] }).__aegisWorkerEvents ?? [];
      return { result: result.result, recordedMs, peakLevel, workerEvents };
    } finally {
      capture.stop();
      navigator.mediaDevices.getUserMedia = original;
      await context.close();
    }
  });
  expect(outcome.recordedMs).toBeGreaterThan(2000);
  expect(outcome.peakLevel).toBeGreaterThan(0);
  expect(outcome.peakLevel).toBeLessThan(0.01);
  expect(outcome.result.heard, `${outcome.result.detail}; worker events: ${JSON.stringify(outcome.workerEvents)}`).toBe("1234");
  expect(outcome.result.matched).toBe(4);
});
