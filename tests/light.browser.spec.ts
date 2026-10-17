
import { test, expect } from "@playwright/test";

// Drives the real static export using Chromium's synthetic camera.
// The synthetic camera has no face, so the live challenges are
// skipped to reach the optional light-reflection stage.
// These tests verify UI behavior, not real liveness detection.

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Fake camera flags are Chromium-only"
);

test.use({
  permissions: ["camera"],
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

/**
 * Skip the three live challenges and the pulse measurement,
 * then explicitly continue through the new Pulse Result screen.
 */
async function reachLightCheck(
  page: import("@playwright/test").Page
) {
  await page.getByRole("button", {
    name: /Begin live challenges/,
  }).click({ timeout: 60_000 });

  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", {
      name: "Skip this challenge",
    }).click();
  }

  await page.getByRole("button", {
    name: "Skip pulse check",
  }).click();

  await expect(
    page.getByRole("heading", {
      name: "Pulse check skipped",
    })
  ).toBeVisible();

  await page.getByRole("button", {
    name: "Continue to light check",
  }).click();
}

test(
  "fills the viewport, keeps the camera running, and locks then restores auto exposure",
  async ({ page }) => {
    test.setTimeout(120_000);

    // The fake camera has no exposure controls.
    // Emulate a camera supporting manual exposure and
    // white balance, and record all relevant calls.
    await page.addInitScript(() => {
      const log: {
        what: string;
        at: number;
        detail?: unknown;
      }[] = [];

      (
        window as Window & {
          __cameraLog?: typeof log;
        }
      ).__cameraLog = log;

      const settings = new WeakMap<
        MediaStreamTrack,
        Record<string, string>
      >();

      const proto = MediaStreamTrack.prototype;

      const {
        getCapabilities,
        getSettings,
        stop,
      } = proto;

      proto.getCapabilities = function () {
        return {
          ...getCapabilities.call(this),
          exposureMode: ["manual", "continuous"],
          whiteBalanceMode: ["manual", "continuous"],
        } as MediaTrackCapabilities;
      };

      proto.getSettings = function () {
        return {
          ...getSettings.call(this),
          ...(settings.get(this) ?? {}),
        };
      };

      proto.applyConstraints = async function (
        constraints?: MediaTrackConstraints
      ) {
        log.push({
          what: "apply",
          at: performance.now(),
          detail: constraints?.advanced?.[0],
        });

        settings.set(this, {
          ...(settings.get(this) ?? {}),
          ...((constraints?.advanced?.[0] ?? {}) as Record<
            string,
            string
          >),
        });
      };

      proto.stop = function () {
        if (this.kind === "video") {
          log.push({
            what: "stop",
            at: performance.now(),
          });
        }

        return stop.call(this);
      };
    });

    // Start verification and enable the optional light check.
    await page.goto("/verify/");

    await page.locator(".consent input").nth(0).check();
    await page.locator(".consent input").nth(1).check();

    await page.getByRole("button", {
      name: "Enable webcam",
      exact: true,
    }).click();

    await expect(
      page.getByText(
        "For the light check, turn your screen brightness up now."
      )
    ).toBeVisible({ timeout: 60_000 });

    // Advance through challenges and the new pulse-result screen.
    await reachLightCheck(page);

    // Verify the full-screen light overlay.
    const overlay = page.locator(".light-overlay");

    await expect(overlay).toBeVisible();

    const viewport = page.viewportSize()!;

    expect(await overlay.boundingBox()).toEqual({
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
    });

    await expect(
      page.locator(".light-panel")
    ).toContainText(
      /Keep still, face the screen\s*1 of 6/
    );

    // The skip control must be keyboard-accessible.
    const skipButton = page.getByRole("dialog", {
      name: "Screen light check",
    }).getByRole("button", {
      name: "Skip light check",
    });

    await expect(skipButton).toBeFocused();

    await page.keyboard.press("Tab");

    await expect(
      page.locator(".light-skip")
    ).toBeFocused();

    // Both video elements must remain active.
    // The thumbnail uses the same camera track.
    const playback = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("video")].map(
          (v) => ({
            time: v.currentTime,
            paused: v.paused,
            ready: v.readyState,
            thumb: v.classList.contains("light-thumb"),
          })
        )
      );

    const before = await playback();

    const colors = new Set<string>();

    for (let i = 0; i < 25; i++) {
      colors.add(
        await overlay.evaluate(
          (el) => getComputedStyle(el).backgroundColor
        )
      );

      await page.waitForTimeout(100);
    }

    const after = await playback();

    expect(before.length).toBe(2);

    for (let i = 0; i < 2; i++) {
      expect(after[i].paused).toBe(false);

      expect(after[i].ready).toBeGreaterThanOrEqual(2);

      expect(after[i].time).toBeGreaterThan(
        before[i].time + 1
      );
    }

    // Confirm the camera thumbnail is mirrored.
    expect(
      await page.locator(".light-thumb").evaluate(
        (v) => getComputedStyle(v).transform
      )
    ).toBe(
      "matrix(-1, 0, 0, 1, 0, 0)"
    );

    // Verify that the expected stimulus colors appeared.
    const expectedColors = [
      "rgb(255, 59, 48)",
      "rgb(52, 255, 106)",
      "rgb(58, 107, 255)",
    ];

    expect(
      [...colors].some((c) =>
        expectedColors.includes(c)
      )
    ).toBe(true);

    expect(
      [...colors].filter((c) =>
        expectedColors.includes(c)
      ).length
    ).toBeGreaterThanOrEqual(2);

    // Normal motion should preserve the crossfade.
    expect(
      await overlay.evaluate(
        (el) => getComputedStyle(el).transitionDuration
      )
    ).toBe("0.25s");

    // The six color plateaus finish automatically.
    await expect(
      page.locator(".result-view")
    ).toBeVisible({ timeout: 15_000 });

    await expect(overlay).toHaveCount(0);

    await expect(
      page.locator("body")
    ).toContainText(
      "Exposure and white balance locked."
    );

    // Confirm exposure controls were restored before camera shutdown.
    const log = await page.evaluate(
      () =>
        (
          window as Window & {
            __cameraLog?: {
              what: string;
              at: number;
              detail?: unknown;
            }[];
          }
        ).__cameraLog!
    );

    const applies = log.filter(
      (e) => e.what === "apply"
    );

    expect(
      applies.map((e) => e.detail)
    ).toEqual([
      {
        whiteBalanceMode: "manual",
        exposureMode: "manual",
      },
      {
        whiteBalanceMode: "continuous",
        exposureMode: "continuous",
      },
    ]);

    const stopEvent = log.find(
      (e) => e.what === "stop"
    );

    expect(stopEvent).toBeDefined();

    expect(applies[1].at).toBeLessThanOrEqual(
      stopEvent!.at
    );
  }
);

test(
  "Escape skips the light check, and reduced motion removes only the crossfade",
  async ({ page }) => {
    test.setTimeout(120_000);

    // Enable reduced-motion preference.
    await page.emulateMedia({
      reducedMotion: "reduce",
    });

    await page.goto("/verify/");

    // Enable webcam processing and the optional light check.
    await page.locator(".consent input").nth(0).check();
    await page.locator(".consent input").nth(1).check();

    await page.getByRole("button", {
      name: "Enable webcam",
      exact: true,
    }).click();

    // Advance through the new pulse-result screen.
    await reachLightCheck(page);

    const overlay = page.locator(".light-overlay");

    await expect(overlay).toBeVisible();

    // Reduced motion removes the color crossfade.
    expect(
      await overlay.evaluate(
        (el) => getComputedStyle(el).transitionDuration
      )
    ).toBe("0s");

    // Escape must skip the optional light check.
    await page.keyboard.press("Escape");

    await expect(overlay).toHaveCount(0);

    await expect(
      page.locator("body")
    ).toContainText(
      "Light check skipped by the user."
    );
  }
);
