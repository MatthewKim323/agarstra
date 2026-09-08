import { expect, test, type Page } from "@playwright/test";

// Replace only the sensor in this browser context. The UI and collection state
// machine are real; this is timing evidence, not real-person gaze accuracy.
function slowSensor(interval: number, latency: number) {
  return `
    export class CameraTracker {
      timer = null;
      running = false;
      frames = 0;
      setGestureKind() {}
      setGesture() {}
      setCalibration() {}
      getDiagnostics() {
        return {
          running: this.running, frames: this.frames,
          backend: "synthetic slow sensor", gazeModel: "test fixture",
          inferenceMs: ${latency}, calibrated: false,
          gestureConfigured: false, gestureArmed: false,
          reason: "Synthetic eye samples, no webcam used."
        };
      }
      async start(_video, observe) {
        this.running = true;
        const emit = () => {
          if (!this.running || globalThis.__pauseSlowEyeSamples) return;
          this.frames++;
          globalThis.__slowEyeSamplesSent = this.frames;
          observe({
            x: .15, y: .15, quality: 1,
            timestamp: performance.now() - ${latency},
            gesture: false, gestureStrength: .1,
            features: [.015,.012,-.015,.012,.01,.01,.5,.5,
              .15,.15,.3,.35,.1,.1,.6,.35,.1,.1]
          });
        };
        emit();
        this.timer = setInterval(emit, ${interval});
      }
      stop() {
        this.running = false;
        clearInterval(this.timer);
      }
    }
  `;
}

async function startSyntheticCalibration(
  page: Page,
  interval: number,
  latency: number,
) {
  page.setDefaultTimeout(10_000);
  await page.addInitScript(() => {
    if (!navigator.mediaDevices) return;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: () => {
        throw new Error("A real webcam must never open in this test.");
      },
    });
  });
  await page.route(/\/src\/vision\/CameraTracker\.ts(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: slowSensor(interval, latency),
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Camera", exact: true }).click();
  await page
    .getByRole("button", { name: "Enable camera", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Calibrate gaze", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start gaze calibration", exact: true })
    .click();
}

for (const { interval, latency } of [
  { interval: 200, latency: 200 },
  { interval: 300, latency: 0 },
  { interval: 333, latency: 300 },
  { interval: 333, latency: 330 },
]) {
  test(`the first dot advances with ${interval} ms eye frames and ${latency} ms inference delay`, async ({
    page,
  }) => {
    await startSyntheticCalibration(page, interval, latency);
    const marker = page.locator(".calibration-target");
    await expect(marker).toHaveCSS("left", `${1440 * 0.15}px`);
    await expect(page.locator(".calibration-copy")).toContainText("1 of 9");
    await expect(page.locator(".calibration-copy")).toContainText("2 of 9", {
      timeout: 12_000,
    });
    await expect(marker).toHaveCSS("left", `${1440 * 0.5}px`);
    await expect(page.getByTestId("camera-signal-rate")).toHaveText(
      /^[1-9]\d*(?:\.\d+)? \/ sec$/,
    );
    await expect(page.locator('[data-camera-highlight="true"]')).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Use calibrated input", exact: true }),
    ).toBeHidden();

    // Losing input must not freeze a last-good rate on screen or finish a point.
    await page.evaluate(() => {
      (
        window as Window & { __pauseSlowEyeSamples?: boolean }
      ).__pauseSlowEyeSamples = true;
    });
    await expect(page.locator(".calibration-copy")).toContainText("paused", {
      timeout: 3_000,
    });
    await expect(page.locator(".calibration-copy")).toContainText("2 of 9");
    await expect(page.getByTestId("camera-signal-rate")).toHaveText(
      /^0(?:\.0)? \/ sec$/,
      { timeout: 3_000 },
    );
    await expect(page.getByTestId("camera-accepted-samples")).toHaveText("0");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  });
}

test("fresh deliveries of stale captures never look usable or advance calibration", async ({
  page,
}) => {
  await startSyntheticCalibration(page, 200, 400);
  await expect(page.locator(".calibration-copy")).toContainText("paused");
  // Deliver ten high-quality observations while retaining their stale timestamps.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __slowEyeSamplesSent?: number })
            .__slowEyeSamplesSent ?? 0,
      ),
    )
    .toBeGreaterThanOrEqual(10);
  await expect(page.getByTestId("camera-signal-rate")).toHaveText("0.0 / sec");
  await expect(page.getByTestId("camera-accepted-samples")).toHaveText("0");
  await expect(page.getByTestId("camera-signal-state")).toContainText(
    "No current usable eye observations",
  );
  await expect(page.locator(".calibration-copy")).toContainText("1 of 9");
  await expect(page.locator(".calibration-target")).toHaveCSS("left", "216px");
  await expect(
    page.getByRole("button", { name: "Use calibrated input", exact: true }),
  ).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});
