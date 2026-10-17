import { test, expect } from "@playwright/test";

// Drives the real static export with Chromium's synthetic camera. It has no face, so the
// challenges are skipped to reach the light stage; nothing here measures a real reflection.
test.skip(({ browserName }) => browserName !== "chromium", "fake camera flags are Chromium-only");
test.use({ permissions: ["camera"], launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });


test("fills the viewport, keeps the camera running, and locks then restores auto exposure", async ({ page }) => {
  test.setTimeout(120_000);
  // The fake camera has no exposure controls; emulate a webcam that does, and log every call.
  await page.addInitScript(() => {
    const log: { what: string; at: number; detail?: unknown }[] = [];
    (window as Window & { __cameraLog?: typeof log }).__cameraLog = log;
    const settings = new WeakMap<MediaStreamTrack, Record<string, string>>();
    const proto = MediaStreamTrack.prototype;
    const { getCapabilities, getSettings, stop } = proto;
    proto.getCapabilities = function () {
      return { ...getCapabilities.call(this), exposureMode: ["manual", "continuous"], whiteBalanceMode: ["manual", "continuous"] } as MediaTrackCapabilities;
    };
    proto.getSettings = function () { return { ...getSettings.call(this), ...(settings.get(this) ?? {}) }; };
    proto.applyConstraints = async function (constraints?: MediaTrackConstraints) {
      log.push({ what: "apply", at: performance.now(), detail: constraints?.advanced?.[0] });
      settings.set(this, { ...(settings.get(this) ?? {}), ...((constraints?.advanced?.[0] ?? {}) as Record<string, string>) });
    };
    proto.stop = function () { if (this.kind === "video") log.push({ what: "stop", at: performance.now() }); return stop.call(this); };
  });

  await page.goto("/verify/");
  await page.locator(".consent input").nth(0).check();
  await page.locator(".consent input").nth(1).check();
  await page.getByRole("button", { name: "Enable webcam", exact: true }).click();
  await expect(page.getByText("For the light check, turn your screen brightness up now.")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /Begin live challenges/ }).click();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Skip this challenge" }).click(); // auto-advance, no Next button
  await page.getByRole("button", { name: "Skip pulse check" }).click();

  const overlay = page.locator(".light-overlay");
  await expect(overlay).toBeVisible();
  const viewport = page.viewportSize()!;
  expect(await overlay.boundingBox()).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  await expect(page.locator(".light-panel")).toContainText(/Keep still, face the screen\s*1 of 6/);
  await expect(page.getByRole("dialog", { name: "Screen light check" }).getByRole("button", { name: "Skip light check" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator(".light-skip")).toBeFocused();

  // The main <video> is covered, not unmounted, and keeps playing; the thumbnail mirrors the same track.
  const playback = () => page.evaluate(() => [...document.querySelectorAll("video")].map(v => ({ time: v.currentTime, paused: v.paused, ready: v.readyState, thumb: v.classList.contains("light-thumb") })));
  const before = await playback();
  const colors = new Set<string>();
  for (let i = 0; i < 25; i++) { colors.add(await overlay.evaluate(el => getComputedStyle(el).backgroundColor)); await page.waitForTimeout(100); }
  const after = await playback();
  expect(before.length).toBe(2);
  for (let i = 0; i < 2; i++) {
    expect(after[i].paused).toBe(false);
    expect(after[i].ready).toBeGreaterThanOrEqual(2);
    expect(after[i].time).toBeGreaterThan(before[i].time + 1);
  }
  expect(await page.locator(".light-thumb").evaluate(v => getComputedStyle(v).transform)).toBe("matrix(-1, 0, 0, 1, 0, 0)");
  expect([...colors].some(c => c === "rgb(255, 59, 48)" || c === "rgb(52, 255, 106)" || c === "rgb(58, 107, 255)")).toBe(true);
  expect([...colors].filter(c => ["rgb(255, 59, 48)", "rgb(52, 255, 106)", "rgb(58, 107, 255)"].includes(c)).length).toBeGreaterThanOrEqual(2);
  expect(await overlay.evaluate(el => getComputedStyle(el).transitionDuration)).toBe("0.25s");

  // Six 1.5 s plateaus, then the result. No face in the fake feed, so no measurement, but the lock is reported.
  await expect(page.locator(".result-view")).toBeVisible({ timeout: 15_000 });
  await expect(overlay).toHaveCount(0);
  await expect(page.locator("body")).toContainText("Exposure and white balance locked.");
  const log = await page.evaluate(() => (window as Window & { __cameraLog?: { what: string; at: number; detail?: unknown }[] }).__cameraLog!);
  const applies = log.filter(e => e.what === "apply");
  expect(applies.map(e => e.detail)).toEqual([
    { whiteBalanceMode: "manual", exposureMode: "manual" },
    { whiteBalanceMode: "continuous", exposureMode: "continuous" },
  ]);
  const stopAt = log.find(e => e.what === "stop")!.at;
  expect(applies[1].at).toBeLessThanOrEqual(stopAt); // restored before the camera closed
});

test("Escape skips the light check, and reduced motion removes only the crossfade", async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/verify/");
  await page.locator(".consent input").nth(0).check();
  await page.locator(".consent input").nth(1).check();
  await page.getByRole("button", { name: "Enable webcam", exact: true }).click();
  await page.getByRole("button", { name: /Begin live challenges/ }).click({ timeout: 60_000 });
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Skip this challenge" }).click();
  await page.getByRole("button", { name: "Skip pulse check" }).click();
  const overlay = page.locator(".light-overlay");
  await expect(overlay).toBeVisible();
  expect(await overlay.evaluate(el => getComputedStyle(el).transitionDuration)).toBe("0s");
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  await expect(page.locator("body")).toContainText("Light check skipped by the user.");
});
