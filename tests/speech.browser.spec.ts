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
    const urls = (JSON.parse(match[2]) as string[]).map(path => `/_next/${path}`).reverse();
    return `/_next/${match[1]}#params=${encodeURIComponent(JSON.stringify([urls, "", "", "", ""]))}`;
  }
  throw new Error("Cannot locate the production speech worker; update the test harness for this bundler output.");
}

test("quiet speech passes through microphone capture and the real speech worker", async ({ page }) => {
  test.setTimeout(120_000);
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
  const outcome = await page.evaluate(async () => {
    // Dynamic paths keep these test-only modules out of the application bundle.
    const base = "/__speech-test__/lib/";
    const { AudioCapture } = await import(base + "audio.ts");
    const { DigitsCheck } = await import(base + "speech.ts");
    const context = new AudioContext({ sampleRate: 16000 });
    await context.resume();
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
      return { result: result.result, recordedMs, peakLevel };
    } finally {
      capture.stop();
      navigator.mediaDevices.getUserMedia = original;
      await context.close();
    }
  });
  expect(outcome.recordedMs).toBeGreaterThan(2000);
  expect(outcome.peakLevel).toBeGreaterThan(0);
  expect(outcome.peakLevel).toBeLessThan(0.01);
  expect(outcome.result.heard, outcome.result.detail).toBe("1234");
  expect(outcome.result.matched).toBe(4);
});
