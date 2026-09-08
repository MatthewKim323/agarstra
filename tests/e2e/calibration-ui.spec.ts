import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";

/**
 * Browser-only sensor fixture. Route replacement affects this test context only;
 * production code has no fixture switch, special observation hook, or backdoor.
 * CameraPanel, GazeCalibrationSession, fitting, validation, and export stay real.
 */
const syntheticTrackerModule = String.raw`
export class CameraTracker {
  timer = null;
  running = false;
  frames = 0;
  calibration = null;
  gesture = null;
  setCalibration(model) {
    this.calibration = model;
    if (model) globalThis.__calibrationUiFixture.installedModels++;
  }
  setGesture(config) { this.gesture = config; }
  setGestureKind() {}
  getEnvironment() {
    return this.running ? {
      deviceId: "synthetic-ui-camera", captureWidth: 640, captureHeight: 480,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio, viewportScale: window.visualViewport?.scale ?? 1,
      pipelineVersion: "synthetic-ui-v1", featureCount: 18
    } : null;
  }
  getDiagnostics() {
    return {
      running: this.running,
      backend: "synthetic test observations, no webcam",
      gazeModel: "test fixture, not model accuracy",
      calibrated: Boolean(this.calibration),
      gestureConfigured: Boolean(this.gesture),
      gestureArmed: false,
      reason: "Synthetic eye observations for UI integration testing.",
      frames: this.frames,
      inferenceMs: 0,
    };
  }
  async start(_video, onObservation) {
    this.running = true;
    const emit = () => {
      if (!this.running) return;
      const marker = document.querySelector(".calibration-target");
      const phase = document.querySelector(".calibration-copy .section-kicker")?.textContent ?? "";
      let x = marker ? parseFloat(marker.style.left) / 100 : 0.5;
      const y = marker ? parseFloat(marker.style.top) / 100 : 0.5;
      // A stable miss at exactly one independent target. This is bias, not jitter.
      if (phase.includes("INDEPENDENT CHECK") && Math.abs(x - 0.3) < 0.001 && Math.abs(y - 0.3) < 0.001) x += 0.3;
      if (marker) globalThis.__calibrationUiFixture.targetFrames++;
      this.frames++;
      onObservation({
        x, y,
        timestamp: performance.now(),
        quality: 1,
        gesture: false,
        gestureStrength: 0.1,
        features: [
          x * 0.1, y * 0.08, -x * 0.1, y * 0.08,
          0.01, 0.01, 0.5, 0.5,
          x, y,
          0.3, 0.35, 0.1, 0.1, 0.6, 0.35, 0.1, 0.1,
        ],
      });
    };
    emit();
    this.timer = setInterval(emit, 60);
  }
  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }
}
`;

type FixtureState = {
  cameraRequests: number;
  installedModels: number;
  targetFrames: number;
};

async function fixtureState(page: Page): Promise<FixtureState> {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __calibrationUiFixture?: FixtureState;
        }
      ).__calibrationUiFixture!,
  );
}

async function checkAccessibility(page: Page, label: string) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  await test.info().attach(`axe-calibration-${label}`, {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(
    result.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

test("real calibration UI waits for Ready, rejects a biased check, and exports only numeric diagnostics", async ({
  page,
}) => {
  test.setTimeout(75_000);
  page.setDefaultTimeout(10_000);
  const apiMutations: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith("/api/") &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method())
    )
      apiMutations.push(
        `${request.method()} ${new URL(request.url()).pathname}`,
      );
  });

  await page.clock.install();
  await page.addInitScript(() => {
    const scope = window as Window & {
      __calibrationUiFixture?: FixtureState;
    };
    scope.__calibrationUiFixture = {
      cameraRequests: 0,
      installedModels: 0,
      targetFrames: 0,
    };
    if (!navigator.mediaDevices) return;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        scope.__calibrationUiFixture!.cameraRequests++;
        throw new DOMException(
          "Real webcam forbidden in this test",
          "NotAllowedError",
        );
      },
    });
  });
  await page.route(/\/src\/vision\/CameraTracker\.ts(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: syntheticTrackerModule,
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Camera", exact: true }).click();
  await expect(page.getByTestId("camera-signal-rate")).toHaveText("0.0 / sec");
  await expect(page.locator('[data-camera-highlight="true"]')).toHaveCount(0);
  await page
    .getByRole("button", { name: "Enable camera", exact: true })
    .click();
  await expect
    .poll(async () =>
      parseFloat(await page.getByTestId("camera-signal-rate").innerText()),
    )
    .toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Calibrate gaze", exact: true })
    .click();

  const ready = page.getByRole("button", {
    name: "Start gaze calibration",
    exact: true,
  });
  await expect(ready).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Teach the camera where you look." }),
  ).toBeVisible();
  await expect(page.locator(".calibration-target")).toHaveCount(0);
  // A wait longer than the 25-second target timeout must not consume Ready time.
  // Do not jump the clock after Start: normal frame timing exercises stability.
  await page.clock.fastForward(30_000);
  await expect(ready).toBeVisible();
  expect((await fixtureState(page)).targetFrames).toBe(0);
  await expect(page.locator('[data-camera-highlight="true"]')).toHaveCount(0);
  await checkAccessibility(page, "ready");
  await page.screenshot({ path: "test-results/nerve-gaze-ready.png" });

  await ready.click();
  await expect(page.locator(".calibration-target")).toHaveCount(1);
  await expect(page.getByTestId("camera-accepted-samples")).toBeVisible();
  await expect(page.locator('[data-camera-highlight="true"]')).toHaveCount(0);
  await expect(
    page.getByRole("progressbar", { name: "Current gaze point progress" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your independent gaze check" }),
  ).toBeVisible({ timeout: 45_000 });

  await expect(page.locator(".validation-result")).toContainText(
    "Not accepted. No gaze actions are enabled.",
  );
  await expect(page.locator(".camera-message")).toContainText(
    /average error [0-9.]+ passes/,
  );
  await expect(page.locator(".camera-message")).toContainText(
    /95th-percentile error [0-9.]+ exceeds 0.255/,
  );
  await expect(page.locator(".gaze-error-table tbody tr")).toHaveCount(5);
  await expect(
    page.getByRole("img", { name: /^Gaze check map/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Eyes only", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Gaze + gesture", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Calibrate gesture", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Use calibrated input", exact: true }),
  ).toBeHidden();
  expect((await fixtureState(page)).installedModels).toBe(0);
  await checkAccessibility(page, "rejected-results");
  await page.locator(".gaze-results").scrollIntoViewIfNeeded();
  // A full-page screenshot can resize the viewport and intentionally invalidate
  // the camera calibration. Capture the current viewport without changing it.
  await page.screenshot({
    path: "test-results/nerve-gaze-rejected-results.png",
  });

  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download numeric diagnostics", exact: true })
    .click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("nerve-gaze-diagnostics.json");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const serialized = await readFile(downloadPath!, "utf8");
  const report = JSON.parse(serialized);
  expect(report.schema).toBe("nerve-gaze-diagnostics-v1");
  expect(report.result).toBe("done");
  expect(report.passed).toBe(false);
  expect(report.thresholds).toEqual({ meanError: 0.15, p95Error: 0.255 });
  expect(report.collections).toHaveLength(14);
  expect(
    report.collections.filter(
      (item: { phase: string }) => item.phase === "gaze",
    ),
  ).toHaveLength(9);
  expect(
    report.collections.filter(
      (item: { phase: string }) => item.phase === "validation",
    ),
  ).toHaveLength(5);
  expect(report.validation.targets).toHaveLength(5);
  expect(report.validation.meanError).toBeLessThan(0.15);
  expect(report.validation.p95Error).toBeGreaterThan(0.255);
  expect(report.validation.failureReason).toBe("tail-error");
  expect(report.validation.targets[0].dispersion).toBeLessThan(0.001);
  expect(report.fit.trainingTargets).toBe(9);
  expect(report.fit.crossValidationError).toBeLessThan(0.05);
  expect(report.cameraSignal.windowMs).toBe(2000);
  expect(report.cameraSignal.usableObservations).toBeGreaterThan(140);
  expect(report.cameraSignal.usablePerSecond).toBeGreaterThan(0);
  expect(report.cameraSignal.lastUsableArrivalAgeMs).toBeLessThanOrEqual(350);
  for (const property of [
    "features",
    "landmarks",
    "video",
    "image",
    "weightsX",
    "weightsY",
    "means",
    "scales",
    "centers",
  ])
    expect(serialized).not.toContain(`"${property}"`);
  expect(serialized).not.toContain("data:image");
  expect((await fixtureState(page)).cameraRequests).toBe(0);
  expect(apiMutations).toEqual([]);

  await page
    .getByRole("button", { name: "Calibrate gaze", exact: true })
    .click();
  await expect(ready).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel calibration", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Download numeric diagnostics",
      exact: true,
    }),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Calibrate gesture", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Stop camera", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(apiMutations).toEqual([]);
});
