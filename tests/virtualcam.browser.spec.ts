import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A moving 90-frame clip with an unchanged textured background, looped by Chromium. */
function loopingFeed(): string {
  const width = 320, height = 240;
  const parts: Buffer[] = [Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`)];
  const texture = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    texture[y * width + x] = 85 + ((x * 13 + y * 7 + ((x ^ y) & 31)) % 60);
  }
  for (let frame = 0; frame < 90; frame++) {
    const luma = Buffer.from(texture);
    const left = 34 + (frame * 11) % 185;
    const top = 70 + Math.round(25 * Math.sin(frame / 8));
    for (let y = top; y < top + 70; y++) for (let x = left; x < left + 75; x++) luma[y * width + x] = 225;
    parts.push(Buffer.from("FRAME\n"), luma, Buffer.alloc(width * height / 2, 128));
  }
  const file = join(mkdtempSync(join(tmpdir(), "aegis-virtual-loop-")), "moving.y4m");
  writeFileSync(file, Buffer.concat(parts));
  return file;
}

test.skip(({ browserName, isMobile }) => browserName !== "chromium" || isMobile, "Desktop Chromium synthetic camera only");
test.use({ permissions: ["camera"], launchOptions: { args: [
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
  `--use-file-for-fake-video-capture=${loopingFeed()}`
] } });

test("a looped moving clip with a frozen background raises a virtual-camera attack check", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/verify/");
  await page.locator(".consent input").first().check();
  await page.getByRole("button", { name: "Enable webcam" }).click();
  await expect(page.getByRole("button", { name: /Begin live challenges/ })).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(6000); // at least one 3 s repeat and a 30-frame matching run
  await page.getByRole("button", { name: /Begin live challenges/ }).click();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Skip this challenge" }).click();
  await page.getByRole("button", { name: "Skip pulse check" }).click();
  await page.getByRole("button", { name: "See summary result" }).click();

  const virtual = page.locator(".attack-check-card", { has: page.getByRole("heading", { name: "Virtual camera" }) });
  await expect(virtual).toContainText("Likely");
  await expect(virtual).toContainText("feed_loop fired");
  await expect(virtual).toContainText("frozen_background fired");
  await expect(page.locator(".result-hero .decision-badge")).toContainText("Reject");
  const replay = page.locator(".attack-check-card", { has: page.getByRole("heading", { name: "Screen replay" }) });
  await expect(replay).toContainText("Not enough evidence");
});
