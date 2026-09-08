import { expect, test, type Page } from "@playwright/test";
import { gazeZoneCenter, type GazeZone } from "../../src/core/gaze-activation";
import type { SessionState } from "../../shared/types";

/** Only the camera setup/sensor is replaced. App, gaze gating and learning run normally. */
async function setup(page: Page, longAction?: string) {
  await page.clock.install();
  let state: SessionState = {
    mode: "practice",
    status: "idle",
    model: "test",
    configured: false,
    screenshot:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    url: "http://127.0.0.1/practice",
    title: "Practice inbox",
    width: 1280,
    height: 800,
    revision: 1,
    proposal: null,
    events: [],
    message: "Ready.",
    goal: "",
    steps: 0,
    maxSteps: 20,
    screenConsent: false,
  };
  const requests: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem(
      "nerve.intent-options.v1",
      JSON.stringify({ enabled: true, remember: true }),
    );
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: () => {
        throw new Error("Real webcam access is forbidden in this test.");
      },
    });
  });
  await page.route(
    /\/src\/components\/CameraPanel\.tsx(?:\?.*)?$/,
    async (route) => {
      const original = await (await route.fetch()).text();
      const reactUrl = original.match(
        /["']([^"']*\/react\.js\?[^"']+)["']/,
      )?.[1];
      if (!reactUrl)
        throw new Error(
          "Could not find the app's React module for camera fixture.",
        );
      await route.fulfill({
        contentType: "application/javascript",
        body: `
      import React from ${JSON.stringify(reactUrl)};
      const { createElement, useEffect, useRef } = React;
      export function CameraPanel(props) {
        const callbacks = useRef(props); callbacks.current = props;
        const running = useRef(false);
        useEffect(() => {
          callbacks.current.onStop(() => { running.current = false; callbacks.current.onReady(false); });
          const timer = setInterval(() => {
            if (!running.current) return;
            const gaze = window.__eyesTestGaze || { x: .5, y: .5, quality: 0 };
            callbacks.current.onObservation({ ...gaze, timestamp: performance.now(), gesture: false, features: [] });
          }, 50);
          return () => clearInterval(timer);
        }, []);
        if (!props.open) return null;
        return createElement('button', { style: { position: 'fixed', inset: '20px auto auto 20px', zIndex: 9999 }, onClick() {
          running.current = true;
          props.onActivationChange('dwell');
          props.onReady(true);
          props.onClose();
        } }, 'Use synthetic calibrated camera');
      }
    `,
      });
    },
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/candidates") {
      const point = route.request().postDataJSON()?.point;
      if (point) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(1);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(1);
      }
      return route.fulfill({
        json: {
          state,
          source: "practice",
          candidates: [
            {
              id: "reply",
              label: "Draft a reply",
              description: "Prepare a draft",
              goal: "Save a draft reply",
              probability: 0.45,
              risk: "confirm",
            },
            {
              id: "note",
              label: "Save a note",
              description: "Keep the details",
              goal: "Save a note",
              probability: 0.35,
              risk: "low",
            },
            {
              id: "archive",
              label: "Archive message",
              description: "Move out of inbox",
              goal: "Archive the message",
              probability: 0.2,
              risk: "confirm",
            },
          ],
        },
      });
    }
    if (path === "/api/intent") {
      expect(route.request().postDataJSON().expectedRevision).toBe(
        state.revision,
      );
      const revision = state.revision + 1;
      state = {
        ...state,
        revision,
        status: "approval",
        proposal: {
          id: `proposal-${revision}`,
          revision,
          summary: "Save the draft",
          actions: longAction
            ? [{ type: "type", text: longAction }]
            : [{ type: "click", x: 10, y: 20 }],
          createdAt: Date.now(),
          expiresAt: Date.now() + 600_000,
          safetyWarnings: [],
        },
      };
      return route.fulfill({ json: state });
    }
    if (path === "/api/approve") {
      expect(route.request().postDataJSON().proposalId).toBe(
        state.proposal?.id,
      );
      state = {
        ...state,
        revision: state.revision + 1,
        status: "completed",
        proposal: null,
        steps: 1,
        message: "Draft saved.",
      };
      return route.fulfill({ json: state });
    }
    if (path === "/api/stop") {
      state = {
        ...state,
        revision: state.revision + 1,
        status: "stopped",
        proposal: null,
      };
      return route.fulfill({ json: state });
    }
    throw new Error(`Unexpected test bridge request ${path}`);
  });
  await page.goto("/");
  await expect(page.locator('[data-scan-id="intent-0"]')).toBeEnabled();
  await page.getByRole("button", { name: "Camera", exact: true }).click();
  await page
    .getByRole("button", { name: "Use synthetic calibrated camera" })
    .click();
  return requests;
}

async function look(page: Page, zone: GazeZone, duration: number, quality = 1) {
  await page.evaluate(
    (gaze) => {
      (window as Window & { __eyesTestGaze?: typeof gaze }).__eyesTestGaze =
        gaze;
    },
    { ...gazeZoneCenter(zone), quality },
  );
  for (let elapsed = 0; elapsed < duration; elapsed += 50)
    await page.clock.runFor(Math.min(50, duration - elapsed));
}

async function passControlCheck(page: Page) {
  for (const zone of ["primary", "secondary", "neutral", "stop"] as const)
    await look(page, zone, 1900);
  await expect(page.getByTestId("eyes-workspace")).toHaveAttribute(
    "data-gaze-check",
    "passed",
  );
  await expect(page.getByTestId("gaze-attention-view")).toBeVisible();
  await look(page, "neutral", 1000);
  await expect(page.getByTestId("gaze-attention-view")).toBeHidden();
  await look(page, "neutral", 600);
  await expect(page.getByTestId("eyes-workspace")).toHaveAttribute(
    "data-gaze-armed",
    "true",
  );
}

test("eyes alone complete preview, confirmation and approval, learning only the accepted goal", async ({
  page,
}, testInfo) => {
  const requests = await setup(page);
  await passControlCheck(page);
  expect(requests.filter((path) => path === "/api/candidates")).toHaveLength(1);
  expect(requests.filter((path) => path === "/api/stop")).toHaveLength(0);
  await look(page, "primary", 1200);
  await expect(
    page.getByRole("heading", { name: "Is this what you want?" }),
  ).toBeVisible();
  expect(requests.filter((path) => path === "/api/intent")).toHaveLength(0);
  // Holding the same position cannot confirm the replacement control.
  await look(page, "primary", 2500);
  expect(requests.filter((path) => path === "/api/intent")).toHaveLength(0);
  await look(page, "neutral", 450);
  await look(page, "primary", 1200);
  await expect(
    page.getByRole("heading", { name: "Review this action" }),
  ).toBeVisible();
  await expect(page.locator(".eyes-learning-note")).toContainText("1 learned.");
  await look(page, "primary", 2500);
  expect(requests.filter((path) => path === "/api/approve")).toHaveLength(0);
  await look(page, "neutral", 450);
  await look(page, "primary", 1200);
  await expect(
    page.getByRole("heading", { name: "Task complete. What next?" }),
  ).toBeVisible();
  expect(requests.filter((path) => path === "/api/approve")).toHaveLength(1);
  await expect(page.locator(".eyes-learning-note")).toContainText("1 learned.");
  await page.screenshot({ path: testInfo.outputPath("nerve-eyes-flow.png") });
  const saved = await page.evaluate(() =>
    localStorage.getItem("nerve.intent-learning.v1"),
  );
  expect(JSON.parse(saved!).models.practice.examples).toBe(1);
  await look(page, "stop", 800);
  await expect(
    page.getByRole("heading", { name: "Stopped", exact: true }),
  ).toBeVisible();
  await look(page, "neutral", 600);
  await look(page, "secondary", 1200);
  await expect(page.getByTestId("eyes-workspace")).toBeHidden();
  expect(
    await page.evaluate(() => localStorage.getItem("nerve.intent-learning.v1")),
  ).toBe(saved);
});

test("explicit none learns the rejection and reopens workspace attention", async ({
  page,
}) => {
  const requests = await setup(page);
  const attentionRequests: { point?: { x: number; y: number } }[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/candidates")
      attentionRequests.push(request.postDataJSON());
  });
  await passControlCheck(page);
  const primary = page.locator('[data-gaze-zone="primary"]');
  for (let next = 0; next < 3; next++) {
    await look(page, "neutral", 600);
    await look(page, "secondary", 1200);
  }
  await expect(primary).toContainText("None of these");
  await look(page, "neutral", 600);
  await look(page, "primary", 1200);
  await expect(page.getByTestId("gaze-attention-view")).toBeVisible();
  expect(requests.filter((path) => path === "/api/intent")).toHaveLength(0);
  const profile = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("nerve.intent-learning.v1")!),
  );
  expect(profile.models.practice.examples).toBe(1);
  expect(profile.models.practice.metrics.confirm.noneCount).toBe(1);
  // No new steady signal: the timeout returns to choices without reusing old focus.
  await look(page, "neutral", 9000, 0);
  await expect(page.getByTestId("gaze-attention-view")).toBeHidden();
  expect(attentionRequests[0].point).toBeDefined();
  expect(attentionRequests.at(-1)?.point).toBeUndefined();
});

test("long exact actions can be reviewed in gaze pages before approval", async ({
  page,
}) => {
  const requests = await setup(page, "a".repeat(500));
  await passControlCheck(page);
  await look(page, "primary", 1200);
  await expect(
    page.getByRole("heading", { name: "Is this what you want?" }),
  ).toBeVisible();
  await look(page, "neutral", 600);
  await look(page, "primary", 1200);
  await expect(
    page.getByRole("heading", { name: "Review this action" }),
  ).toBeVisible();
  const primary = page.locator('[data-gaze-zone="primary"]');
  await expect(primary).toBeDisabled();
  await expect(primary).toContainText("Detail 1 of 2");
  await look(page, "neutral", 600);
  await look(page, "primary", 1500);
  expect(requests.filter((path) => path === "/api/approve")).toHaveLength(0);
  await look(page, "secondary", 1200);
  await expect(primary).toContainText("Detail 2 of 2");
  await expect(primary).toBeEnabled();
  await look(page, "primary", 1500);
  expect(requests.filter((path) => path === "/api/approve")).toHaveLength(0);
  await look(page, "neutral", 600);
  await look(page, "primary", 1200);
  await expect(
    page.getByRole("heading", { name: "Task complete. What next?" }),
  ).toBeVisible();
  expect(requests.filter((path) => path === "/api/approve")).toHaveLength(1);
});

test("failed control check cannot authorize a task", async ({ page }) => {
  const requests = await setup(page);
  await look(page, "primary", 12_000);
  expect(requests.filter((path) => path === "/api/intent")).toHaveLength(0);
  expect(requests.filter((path) => path === "/api/approve")).toHaveLength(0);
  await expect(
    page.getByText("Gaze did not reliably reach this control.", {
      exact: false,
    }),
  ).toBeVisible();
});

test("tracking loss cannot rearm, and finishing keeps saved learning", async ({
  page,
}) => {
  const requests = await setup(page);
  await passControlCheck(page);
  await look(page, "primary", 1200);
  await look(page, "neutral", 700, 0);
  await look(page, "primary", 2000);
  expect(requests.filter((path) => path === "/api/intent")).toHaveLength(0);
  // Stop remains usable while ordinary action controls await rearming.
  await look(page, "stop", 800);
  await expect(
    page.getByRole("heading", { name: "Stopped", exact: true }),
  ).toBeVisible();
  await look(page, "neutral", 450);
  await look(page, "secondary", 1200);
  await expect(
    page.getByRole("heading", { name: "Stopped", exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Pointer", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(() => localStorage.getItem("nerve.intent-learning.v1")),
  ).not.toBeNull();
});
