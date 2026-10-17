
import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Synthetic camera fixture for Chromium.
 *
 * Generates a 320x240 YUV4MPEG2 video at 30 FPS.
 *
 * The image changes every 15 frames, creating
 * half-second frozen segments. This makes repeated
 * frames observable even when the browser skips
 * frames during processing.
 *
 * This is a controlled test fixture, not a real
 * camera or a validated deepfake detection benchmark.
 */

function doubledFeed(): string {
  const W = 320;
  const H = 240;

  const parts: Buffer[] = [
    Buffer.from(
      `YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`
    ),
  ];

  for (let i = 0; i < 60; i++) {
    // Keep each image unchanged for 15 frames.
    const k = Math.floor(i / 15);

    const y = Buffer.alloc(W * H);

    for (let p = 0; p < y.length; p++) {
      y[p] =
        (((p % W) + k * 9) ^
          (Math.floor(p / W) * 3)) & 255;
    }

    parts.push(
      Buffer.from("FRAME\n"),
      y,
      Buffer.alloc((W * H) / 2, 128)
    );
  }

  const file = join(
    mkdtempSync(join(tmpdir(), "aegis-feed-")),
    "doubled.y4m"
  );

  writeFileSync(file, Buffer.concat(parts));

  return file;
}

// Synthetic camera flags are supported by Chromium.
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
      `--use-file-for-fake-video-capture=${doubledFeed()}`,
    ],
  },
});

test(
  "a feed of repeated frames is measured in the browser and flagged in the camera-integrity result",
  async ({ page }) => {
    test.setTimeout(120_000);

    // --------------------------------------------------
    // Step 1: Open verification
    // --------------------------------------------------

    await page.goto("/verify/");

    // Grant camera-processing consent.
    await page.locator(".consent input").nth(0).check();

    // --------------------------------------------------
    // Step 2: Start the synthetic camera
    // --------------------------------------------------

    await page
      .getByRole("button", {
        name: "Enable webcam",
        exact: true,
      })
      .click();

    // --------------------------------------------------
    // Step 3: Inspect camera timing evidence
    // --------------------------------------------------

    const timing = page
      .locator(".device-panel dl > div", {
        hasText: "Frame timing",
      })
      .locator("dd");

    await expect(timing).not.toHaveText(
      /Sampling/,
      { timeout: 30_000 }
    );

    // Wait for the measured repeated-frame percentage
    // to exceed the threshold. Do not reduce the
    // detection threshold merely to pass the test.
    await expect
      .poll(
        async () => {
          const text = await timing.innerText();

          const match = text.match(
            /(\d+)% repeated/
          );

          return match
            ? Number(match[1])
            : 0;
        },
        {
          message:
            "Synthetic camera should show more than 20% repeated frames",
          timeout: 30_000,
          intervals: [500, 1000, 2000],
        }
      )
      .toBeGreaterThan(20);

    // --------------------------------------------------
    // Step 4: Verify camera controls
    // --------------------------------------------------

    await expect(
      page
        .locator(".device-panel dl > div", {
          hasText: "Camera controls",
        })
        .locator("dd")
    ).toHaveText(/video input/);

    // --------------------------------------------------
    // Step 5: Start the live challenges
    // --------------------------------------------------

    await page
      .getByRole("button", {
        name: /Begin live challenges/,
      })
      .click({
        timeout: 60_000,
      });

    // Skip all three challenges.
    for (let i = 0; i < 3; i++) {
      await page
        .getByRole("button", {
          name: "Skip this challenge",
        })
        .click();
    }

    // --------------------------------------------------
    // Step 6: Skip the experimental pulse check
    // --------------------------------------------------

    await page
      .getByRole("button", {
        name: "Skip pulse check",
      })
      .click();

    // The updated verification flow displays
    // a separate pulse-result screen.
    await expect(
      page.getByRole("heading", {
        name: "Pulse check skipped",
      })
    ).toBeVisible();

    // --------------------------------------------------
    // Step 7: Continue to the final result
    // --------------------------------------------------

    // The optional light check is disabled.
    await page
      .getByRole("button", {
        name: "See summary result",
      })
      .click();

    await expect(
      page.locator(".result-view")
    ).toBeVisible({
      timeout: 15_000,
    });

    // --------------------------------------------------
    // Step 8: Verify camera-integrity finding
    // --------------------------------------------------

    await expect(
      page.locator("body")
    ).toContainText(
      /\d+% repeated identical frames, as from a frozen or looping feed \(can be legitimate/
    );
  }
);
