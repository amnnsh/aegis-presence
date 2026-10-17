
import { test, expect, type Page } from "@playwright/test";

// Build the static frontend with:
// NEXT_PUBLIC_API_URL=http://localhost:8001
//
// No backend needs to run on port 8001.
// Playwright mocks all API requests.

const API = "http://localhost:8001";
const TOKEN = "playwright-only-admin-token";

const cors = {
  "access-control-allow-origin": "http://localhost:3100",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

// Mock verification session
const session = (id: string) => ({
  id,
  created_at: "2026-10-17T12:00:00Z",
  expires_at: "2026-10-17T12:05:00Z",
  status: "completed",
  plan_consumed: true,
  decision: "step-up",
  risk: 23,
  coverage: 80,
  policy_version: "0.2.0",
  presenter_label: null,
  link_label: null,
  ua_family: "Chromium",
});

// Mock Gemini report
const report = (id: string) => ({
  session_id: id,
  policy_decision: "step-up",
  policy_risk: 23,
  advisory_only: true,
  analyst: {
    summary:
      `Review for ${id.slice(0, 8)}: additional verification required.`,
    findings: [
      {
        signal_id: "liveness",
        observation: "Gesture evidence was incomplete.",
        concern: "medium",
        explanation:
          "Missing evidence cannot establish whether a person is present.",
      },
    ],
    missing_evidence: [
      "Light response not available.",
    ],
    recommended_next_steps: [
      "Use a trusted second factor.",
    ],
    confidence: "medium",
    limitations:
      "This report cannot authenticate a person.",
  },
});

// Configure mocked API responses
async function setup(page: Page) {
  await page.route(/https?:\/\/[^/]+\/api\//, async route => {
    const request = route.request();
    const url = new URL(request.url());

    // Never contact the deployed Render backend.
    if (url.origin !== API) {
      throw new Error(
        `Unsafe test build: API points to ${url.origin}; rebuild for ${API}`
      );
    }

    const path = url.pathname;

    if (request.method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: cors,
        body: "",
      });
    }

    if (path === "/api/health") {
      return route.fulfill({
        headers: cors,
        json: {
          status: "ok",
          policy_version: "0.2.0",
        },
      });
    }

    if (path === "/api/admin/sessions") {
      return route.fulfill({
        headers: cors,
        json: {
          sessions: [session(A), session(B)],
        },
      });
    }

    if (path === "/api/admin/summary") {
      return route.fulfill({
        headers: cors,
        json: {
          total: 2,
          by_presenter_decision: [],
        },
      });
    }

    if (
      path === `/api/admin/sessions/${A}` ||
      path === `/api/admin/sessions/${B}`
    ) {
      const id = path.endsWith(A) ? A : B;

      return route.fulfill({
        headers: cors,
        json: {
          ...session(id),
          events: [],
          result: null,
        },
      });
    }

    if (path === "/api/admin/stream") {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: cors,
        body: ": test stream\n\n",
      });
    }

    // Individual tests handle Gemini analysis.
    if (path.endsWith("/analyze")) {
      return route.fallback();
    }

    throw new Error(`Unexpected API request: ${path}`);
  });

  await page.goto("/admin/");

  await expect(
    page.getByText("LIVE WORKSPACE")
  ).toBeVisible();

  await page.getByPlaceholder("Admin token").fill(TOKEN);

  await page.getByRole("button", {
    name: "Connect",
    exact: true,
  }).click();

  await expect(
    page.getByRole("button", {
      name: "Inspect session 11111111",
    })
  ).toBeVisible();
}

// Open a completed session
async function inspect(page: Page, id: string) {
  await page.getByRole("button", {
    name: `Inspect session ${id.slice(0, 8)}`,
  }).click();

  await expect(
    page.getByRole("heading", {
      name: `Inspecting ${id.slice(0, 8)}`,
    })
  ).toBeVisible();
}

// --------------------------------------------------
// Test 1: Successful Gemini analysis
// --------------------------------------------------

test(
  "renders an advisory report with an authenticated POST",
  async ({ page }) => {
    let requests = 0;

    await page.route(
      `${API}/api/admin/sessions/${A}/analyze`,
      async route => {
        requests++;

        expect(route.request().method()).toBe("POST");

        expect(
          route.request().headers().authorization
        ).toBe(`Bearer ${TOKEN}`);

        await route.fulfill({
          headers: cors,
          json: report(A),
        });
      }
    );

    await setup(page);
    await inspect(page, A);

    await page.getByRole("button", {
      name: "Analyze with Gemini",
    }).click();

    const result = page.locator(".gemini-report");

    await expect(result).toBeVisible();

    await expect(result).toContainText(
      "Gesture evidence was incomplete."
    );

    await expect(result).toContainText(
      "Light response not available."
    );

    await expect(result).toContainText(
      "Use a trusted second factor."
    );

    await expect(result).toContainText(
      "Policy decision: step-up"
    );

    await expect(result).toContainText(
      "Risk index: 23/100"
    );

    expect(requests).toBe(1);

    // Gemini must not change the original policy result.
    await expect(
      page.locator(".live-table")
    ).toContainText("23/100");

    await expect(
      page.locator(".live-table")
    ).toContainText("Step-up");
  }
);

// --------------------------------------------------
// Test 2: Gemini loading state
// --------------------------------------------------

test(
  "shows a disabled loading button until completion",
  async ({ page }) => {
    let release!: () => void;

    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    await page.route(
      `${API}/api/admin/sessions/${A}/analyze`,
      async route => {
        await gate;

        await route.fulfill({
          headers: cors,
          json: report(A),
        });
      }
    );

    await setup(page);
    await inspect(page, A);

    await page.getByRole("button", {
      name: "Analyze with Gemini",
    }).click();

    const pending = page.getByRole("button", {
      name: "Analyzing with Gemini...",
    });

    try {
      await expect(pending).toBeDisabled();

      await expect(
        page.getByRole("status")
      ).toContainText(
        "Generating the security review..."
      );

      await expect(
        page.locator(".gemini-report")
      ).toHaveCount(0);
    } finally {
      release();
    }

    await expect(
      page.locator(".gemini-report")
    ).toBeVisible();

    await expect(
      page.getByRole("button", {
        name: "Analyze with Gemini",
      })
    ).toBeEnabled();
  }
);

// --------------------------------------------------
// Test 3: HTTP 503 error handling
// --------------------------------------------------

test(
  "shows a 503 error without inventing a report",
  async ({ page }) => {
    await page.route(
      `${API}/api/admin/sessions/${A}/analyze`,
      route =>
        route.fulfill({
          status: 503,
          headers: cors,
          json: {
            error: "analyst_unavailable",
            detail:
              "Gemini analysis is temporarily unavailable.",
          },
        })
    );

    await setup(page);
    await inspect(page, A);

    await page.getByRole("button", {
      name: "Analyze with Gemini",
    }).click();

    await expect(
      page.locator(".live-detail .notice[role='alert']")
    ).toContainText(
      "Gemini analysis is temporarily unavailable."
    );

    await expect(
      page.locator(".gemini-report")
    ).toHaveCount(0);

    await expect(
      page.getByRole("button", {
        name: "Analyze with Gemini",
      })
    ).toBeEnabled();
  }
);

// --------------------------------------------------
// Test 4: Wrong session report rejection
// --------------------------------------------------

test(
  "rejects reports for the wrong session",
  async ({ page }) => {
    await page.route(
      `${API}/api/admin/sessions/${A}/analyze`,
      route =>
        route.fulfill({
          headers: cors,
          json: report(B),
        })
    );

    await setup(page);
    await inspect(page, A);

    await page.getByRole("button", {
      name: "Analyze with Gemini",
    }).click();

    await expect(
      page.locator(".live-detail .notice[role='alert']")
    ).toContainText(
      "Invalid advisory report for this session."
    );

    await expect(
      page.locator(".gemini-report")
    ).toHaveCount(0);
  }
);

// --------------------------------------------------
// Test 5: Session switching
// --------------------------------------------------

test(
  "switching sessions clears the previous report",
  async ({ page }) => {
    await page.route(
      `${API}/api/admin/sessions/${A}/analyze`,
      route =>
        route.fulfill({
          headers: cors,
          json: report(A),
        })
    );

    await setup(page);
    await inspect(page, A);

    await page.getByRole("button", {
      name: "Analyze with Gemini",
    }).click();

    await expect(
      page.locator(".gemini-report")
    ).toBeVisible();

    await inspect(page, B);

    await expect(
      page.locator(".gemini-report")
    ).toHaveCount(0);

    await expect(
      page.getByRole("heading", {
        name: "Inspecting 22222222",
      })
    ).toBeVisible();
  }
);

