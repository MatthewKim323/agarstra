import { expect, test, type Page } from "@playwright/test";

const savedSensor = String.raw`
export class CameraTracker {
  timer = null;
  running = false;
  model = null;
  setGestureKind() {}
  setGesture() {}
  setCalibration(model) {
    this.model = model;
    if (model) globalThis.__savedGazeInstalls = (globalThis.__savedGazeInstalls ?? 0) + 1;
  }
  getEnvironment() {
    return this.running ? {
      deviceId: "saved-fixture-camera", captureWidth: 640, captureHeight: 480,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      devicePixelRatio, viewportScale: visualViewport?.scale ?? 1,
      pipelineVersion: "saved-fixture-v1", featureCount: 18
    } : null;
  }
  getDiagnostics() {
    return { running: this.running, inferenceMs: 0, backend: "synthetic saved gaze", reason: "Synthetic eye observations only." };
  }
  async start(_video, observe) {
    this.running = true;
    const emit = () => {
      if (!this.running) return;
      const marker = document.querySelector(".calibration-target");
      const x = marker ? parseFloat(marker.style.left) / 100 : .5;
      const y = marker ? parseFloat(marker.style.top) / 100 : .5;
      observe({ x, y, quality: 1, timestamp: performance.now(), gesture: false,
        features: [x, y, ...Array(16).fill(0)] });
    };
    emit();
    this.timer = setInterval(emit, 100);
  }
  stop() { this.running = false; clearInterval(this.timer); }
}
`;

async function setup(
  page: Page,
  saved: "valid" | "wrong-camera" | "corrupt" = "valid",
) {
  await page.clock.install();
  await page.addInitScript((kind) => {
    // Seed storage once. Reloads must retain user changes made during this test.
    if (!sessionStorage.getItem("saved-gaze-fixture-seeded")) {
      const weightsX = Array(19).fill(0);
      const weightsY = Array(19).fill(0);
      weightsX[1] = 1;
      weightsY[2] = 1;
      const profile = {
        version: 1,
        model: {
          version: 1,
          featureCount: 18,
          means: Array(18).fill(0),
          scales: Array(18).fill(1),
          weightsX,
          weightsY,
          samples: 90,
          createdAt: 1,
        },
        gesture: null,
        activation: "dwell",
        dwellMs: 850,
        savedAt: 1,
        environment: {
          deviceId:
            kind === "wrong-camera"
              ? "different-camera"
              : "saved-fixture-camera",
          captureWidth: 640,
          captureHeight: 480,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          devicePixelRatio,
          viewportScale: visualViewport?.scale ?? 1,
          pipelineVersion: "saved-fixture-v1",
          featureCount: 18,
        },
        lastValidation: {
          checkedAt: 1,
          meanError: 0,
          p95Error: 0,
          sampleCount: 50,
        },
      };
      localStorage.setItem(
        "nerve.gaze-profile.v1",
        kind === "corrupt" ? "{broken" : JSON.stringify(profile),
      );
      sessionStorage.setItem("saved-gaze-fixture-seeded", "true");
    }
    if (navigator.mediaDevices)
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: () => {
          throw new Error("A real camera must never open in this test.");
        },
      });
  }, saved);
  await page.route(/\/src\/vision\/CameraTracker\.ts(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: savedSensor,
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Camera", exact: true }).click();
  await page
    .getByRole("button", { name: "Enable camera", exact: true })
    .click();
}

test("saved eyes-only calibration needs a frozen recheck, survives stop, and can be cleared", async ({
  page,
}) => {
  await setup(page);
  await expect(
    page.getByRole("checkbox", {
      name: "Remember me on this device",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Check gaze controls", exact: true }),
  ).toBeHidden();
  await page
    .getByRole("button", { name: "Check saved calibration", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Check your saved calibration." }),
  ).toBeVisible();
  await expect(page.locator(".calibration-target")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { __savedGazeInstalls?: number })
          .__savedGazeInstalls ?? 0,
    ),
  ).toBe(0);
  await page
    .getByRole("button", { name: "Start saved gaze check", exact: true })
    .click();
  await expect(page.locator(".calibration-copy")).toContainText("1 of 5");
  for (let point = 0; point < 5; point++) await page.clock.runFor(2300);
  await expect(page.locator(".validation-result")).toContainText(
    "Passed the experimental large-control threshold",
  );
  await expect(
    page.getByRole("button", { name: "Check gaze controls", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Calibrate gesture", exact: true }),
  ).toBeHidden();
  expect(
    await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { __savedGazeInstalls?: number })
          .__savedGazeInstalls,
    ),
  ).toBe(1);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("nerve.gaze-profile.v1")!),
  );
  expect(saved.model.createdAt).toBe(1);
  expect(saved.model.samples).toBe(90);
  expect(saved.model.weightsX[1]).toBe(1);
  expect(saved.gesture).toBeNull();
  expect(saved.lastValidation.sampleCount).toBeGreaterThanOrEqual(50);
  await page.setViewportSize({ width: 1450, height: 1000 });
  await expect(
    page.getByRole("button", { name: "Check gaze controls", exact: true }),
  ).toBeHidden();
  await expect(page.getByRole("dialog")).toContainText("configuration changed");
  await expect(
    page.getByRole("button", { name: "Check saved calibration", exact: true }),
  ).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(
    page.getByRole("button", { name: "Check gaze controls", exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Stop camera", exact: true }).click();
  expect(
    await page.evaluate(() => localStorage.getItem("nerve.gaze-profile.v1")),
  ).not.toBeNull();
  await page.getByRole("button", { name: "Camera", exact: true }).click();
  await page
    .getByRole("button", { name: "Enable camera", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Check gaze controls", exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Check saved calibration", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Clear saved setup and learning",
      exact: true,
    })
    .click();
  expect(
    await page.evaluate(() => localStorage.getItem("nerve.gaze-profile.v1")),
  ).toBeNull();
  await expect(
    page.getByRole("checkbox", {
      name: "Remember me on this device",
      exact: true,
    }),
  ).not.toBeChecked();
});

for (const saved of ["wrong-camera", "corrupt"] as const) {
  test(`${saved} profile cannot enter saved recheck or enable controls`, async ({
    page,
  }) => {
    await setup(page, saved);
    await expect(
      page.getByRole("button", {
        name: "Check saved calibration",
        exact: true,
      }),
    ).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Check gaze controls", exact: true }),
    ).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Calibrate gaze", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText(
      saved === "corrupt"
        ? "incompatible or damaged"
        : "does not match this camera",
    );
    expect(
      await page.evaluate(
        () =>
          (globalThis as typeof globalThis & { __savedGazeInstalls?: number })
            .__savedGazeInstalls ?? 0,
      ),
    ).toBe(0);
  });
}
