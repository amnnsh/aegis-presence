import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Chromium plays this file as its camera: 320x240 at 30 fps where the picture only changes
// every second frame, like 15 fps footage pushed through a software camera. Written at import
// time because the browser needs the path at launch.
function doubledFeed(): string {
  const W = 320, H = 240, parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`)];
  for (let i = 0; i < 60; i++) {
    const k = Math.floor(i / 2), y = Buffer.alloc(W * H);
    for (let p = 0; p < y.length; p++) y[p] = (((p % W) + k * 9) ^ (Math.floor(p / W) * 3)) & 255;
    parts.push(Buffer.from("FRAME\n"), y, Buffer.alloc(W * H / 2, 128));
  }
  const file = join(mkdtempSync(join(tmpdir(), "aegis-feed-")), "doubled.y4m");
  writeFileSync(file, Buffer.concat(parts));
  return file;
}

test.skip(({ browserName }) => browserName !== "chromium", "fake camera flags are Chromium-only");
test.use({ permissions: ["camera"], launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${doubledFeed()}`] } });

test("a feed of repeated frames is measured in the browser and flagged in the camera-integrity result", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/verify/");
  await page.locator(".consent input").nth(0).check();
  await page.getByRole("button", { name: "Enable webcam", exact: true }).click();

  const timing = page.locator(".device-panel dl > div", { hasText: "Frame timing" }).locator("dd");
  await expect(timing).not.toHaveText(/Sampling/, { timeout: 30_000 });
  const repeated = Number((await timing.innerText()).match(/(\d+)% repeated/)![1]);
  expect(repeated).toBeGreaterThan(20);
  await expect(page.locator(".device-panel dl > div", { hasText: "Camera controls" }).locator("dd")).toHaveText(/video input/);

  // Skip to the result; the light check is off, so it follows the pulse step.
  await page.getByRole("button", { name: /Begin live challenges/ }).click({ timeout: 60_000 });
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Skip this challenge" }).click();
  await page.getByRole("button", { name: "Skip pulse check" }).click();
  await expect(page.locator(".result-view")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("body")).toContainText(/\d+% repeated identical frames, as from a frozen or looping feed \(can be legitimate/);
});
