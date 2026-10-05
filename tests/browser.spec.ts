import { test, expect } from "@playwright/test";

test("landing loads, explains limits, and fits the viewport", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Trust the person");
  await expect(page.locator("body")).toContainText("40%");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("missing camera cannot approve", async ({ page }) => {
  await page.goto("/verify/");
  await expect(page.getByRole("button", { name: "Enable webcam", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Continue without camera" }).click();
  await expect(page.locator(".result-view .decision-badge")).toHaveText("Step-up");
  await expect(page.locator(".risk-dial strong")).toHaveText("60/100");
  await expect(page.getByText("LIVE SESSION / CAMERA STOPPED")).toBeVisible();
});

test("all attack fixtures are labeled and produce deterministic decisions", async ({ page }) => {
  await page.goto("/verify/?mode=lab");
  await page.getByRole("button", { name: "Run simulated scenario", exact: true }).click();
  for (const [label, decision, score] of [
    ["Normal user", "Approve", "7/100"],
    ["Replayed video", "Reject", "73/100"],
    ["Virtual-camera feed", "Step-up", "31/100"],
    ["Deepfake sample", "Reject", "67/100"],
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator(".result-view .decision-badge")).toHaveText(decision);
    await expect(page.locator(".risk-dial strong")).toHaveText(score);
    await expect(page.locator(".result-view .source-simulated")).toHaveCount(5);
  }
  await page.getByText("Inspect the scoring formula and thresholds").click();
  await expect(page.locator(".policy-details table tbody tr")).toHaveCount(5);
});

test("mock dashboard filters and opens evidence", async ({ page }) => {
  await page.goto("/admin/");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(4);
  await page.getByRole("textbox", { name: "Search mock attempt ID or scenario" }).fill("AX-1047");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "Inspect AX-1047" }).click();
  await expect(page.locator(".inspector .decision-reject")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("static production headers restrict capture and external connections", async ({ request }) => {
  const response = await request.get("/verify/");
  expect(response.ok()).toBe(true);
  expect(response.headers()["permissions-policy"]).toContain("microphone=()");
  expect(response.headers()["content-security-policy"]).toContain("connect-src 'self'");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
});
