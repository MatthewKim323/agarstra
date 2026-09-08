import {
  chromium,
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import type { SessionState } from "../../shared/types";
import {
  GAZE_TRAIN_TARGETS,
  GAZE_VALIDATION_TARGETS,
} from "../../src/vision/calibration-session";

const origin = "http://127.0.0.1:4317";

async function state(request: APIRequestContext): Promise<SessionState> {
  const response = await request.get("/api/state");
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<SessionState>;
}

async function labState(
  request: APIRequestContext,
): Promise<Record<string, unknown>> {
  const response = await request.get("/api/lab-state");
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<Record<string, unknown>>;
}

async function startPractice(page: Page, request: APIRequestContext) {
  await page
    .getByRole("button", { name: "Start practice", exact: true })
    .click();
  await expect.poll(async () => (await state(request)).screenshot).toBeTruthy();
  await expect.poll(async () => (await state(request)).mode).toBe("practice");
}

async function chooseIntent(
  page: Page,
  request: APIRequestContext,
  label: string,
) {
  await page.getByRole("button", { name: new RegExp(label, "i") }).click();
  await page
    .getByRole("button", { name: "Confirm intent", exact: true })
    .click();
  await expect.poll(async () => (await state(request)).status).toBe("approval");
  await expect(
    page.getByRole("button", { name: "Approve action", exact: true }),
  ).toBeVisible();
}

async function approveUntilComplete(page: Page, request: APIRequestContext) {
  const approved = new Set<string>();
  for (let step = 0; step < 8; step++) {
    const current = await state(request);
    if (current.status === "completed") return;
    expect(current.status).toBe("approval");
    expect(current.proposal).not.toBeNull();
    const proposal = current.proposal!;
    expect(approved.has(proposal.id)).toBeFalsy();
    approved.add(proposal.id);
    await page
      .getByRole("button", { name: "Approve action", exact: true })
      .click();
    await expect
      .poll(async () => {
        const next = await state(request);
        return (
          ["completed", "error", "stopped"].includes(next.status) ||
          (next.status === "approval" && next.proposal?.id !== proposal.id)
        );
      })
      .toBeTruthy();
    const result = await state(request);
    expect(["approval", "completed"], result.message).toContain(result.status);
  }
  expect((await state(request)).status).toBe("completed");
}

test.beforeEach(async ({ page, request }) => {
  const reset = await request.post("/api/reset", {
    data: {},
    headers: { Origin: origin },
  });
  expect(reset.ok()).toBeTruthy();
  // Never access a person's real webcam during automated tests.
  await page.addInitScript(() => {
    if (!navigator.mediaDevices) return;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        throw new DOMException(
          "Camera denied by automated test",
          "NotAllowedError",
        );
      },
    });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("loads an accessible no-key practice entry and all input alternatives", async ({
  page,
}) => {
  await expect(page).toHaveTitle(/nerve/i);
  await expect(
    page.getByRole("button", { name: "Start practice", exact: true }),
  ).toBeVisible();
  for (const name of ["Pointer", "Single switch", "Camera"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: /^Emergency stop/ }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/nerve-desktop.png",
    fullPage: true,
  });
});

test("drafts in the actual browser only after approval", async ({
  page,
  request,
}) => {
  await startPractice(page, request);
  const before = await labState(request);
  await chooseIntent(page, request, "Draft a reply");
  expect(await labState(request)).toEqual(before);
  await approveUntilComplete(page, request);
  await expect
    .poll(async () => (await state(request)).status)
    .toBe("completed");
  const after = await labState(request);
  expect(after).not.toEqual(before);
  expect(JSON.stringify(after.draft)).not.toBe(JSON.stringify(before.draft));
  expect(JSON.stringify(after.draft).length).toBeGreaterThan(10);
  expect(
    (await state(request)).events.some((event) => event.kind === "action"),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/nerve-approved-draft.png",
    fullPage: true,
  });
});

test("saves a note with a verified browser state change", async ({
  page,
  request,
}) => {
  await startPractice(page, request);
  const before = await labState(request);
  await chooseIntent(page, request, "Save a note");
  await approveUntilComplete(page, request);
  await expect
    .poll(async () => (await state(request)).status)
    .toBe("completed");
  const after = await labState(request);
  expect(after.notes).not.toEqual(before.notes);
  expect(Array.isArray(after.notes)).toBeTruthy();
  expect((after.notes as unknown[]).length).toBeGreaterThan(
    (before.notes as unknown[]).length,
  );
});

test("archives only after approval and rejects reuse of an approval", async ({
  page,
  request,
}) => {
  await startPractice(page, request);
  const before = await labState(request);
  await chooseIntent(page, request, "Archive message");
  const proposal = (await state(request)).proposal!;
  expect(await labState(request)).toEqual(before);
  await approveUntilComplete(page, request);
  await expect
    .poll(async () => (await state(request)).status)
    .toBe("completed");
  const after = await labState(request);
  expect(after.archivedIds).not.toEqual(before.archivedIds);
  const replay = await request.post("/api/approve", {
    data: { proposalId: proposal.id, revision: proposal.revision },
    headers: { Origin: origin },
  });
  expect(replay.ok()).toBeFalsy();
  expect(await labState(request)).toEqual(after);
});

test("cancel discards an intent without touching the browser", async ({
  page,
  request,
}) => {
  await startPractice(page, request);
  const before = await labState(request);
  await chooseIntent(page, request, "Archive message");
  await page
    .getByRole("button", { name: "Cancel action", exact: true })
    .click();
  await expect.poll(async () => (await state(request)).proposal).toBeNull();
  expect(await labState(request)).toEqual(before);
  await expect(
    page.getByRole("button", { name: "Approve action", exact: true }),
  ).toBeHidden();
});

test("emergency stop invalidates an outstanding proposal", async ({
  page,
  request,
}) => {
  await startPractice(page, request);
  const before = await labState(request);
  await chooseIntent(page, request, "Draft a reply");
  const proposal = (await state(request)).proposal!;
  await page.getByRole("button", { name: /^Emergency stop/ }).click();
  await expect.poll(async () => (await state(request)).status).toBe("stopped");
  expect((await state(request)).proposal).toBeNull();
  const stale = await request.post("/api/approve", {
    data: { proposalId: proposal.id, revision: proposal.revision },
    headers: { Origin: origin },
  });
  expect(stale.ok()).toBeFalsy();
  expect(await labState(request)).toEqual(before);
});

test("Escape provides keyboard emergency stop", async ({ page, request }) => {
  await startPractice(page, request);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await state(request)).status).toBe("stopped");
});

test("keyboard can focus controls and change input modes", async ({ page }) => {
  const switchButton = page.getByRole("button", {
    name: "Single switch",
    exact: true,
  });
  await switchButton.focus();
  await expect(switchButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(switchButton).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Pointer", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Pointer", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("camera denial leaves pointer and practice usable", async ({
  page,
  request,
}) => {
  await page.getByRole("button", { name: "Camera", exact: true }).click();
  await page
    .getByRole("button", { name: "Enable camera", exact: true })
    .click();
  await expect(
    page
      .getByText(/camera.*(denied|permission|allow)|permission.*camera/i)
      .first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back to workspace", exact: true })
    .click();
  await page.getByRole("button", { name: "Pointer", exact: true }).click();
  await startPractice(page, request);
  await chooseIntent(page, request, "Save a note");
});

test("primary controls remain reachable on a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Start practice", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Emergency stop/ }),
  ).toBeVisible();
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflows).toBeFalsy();
  const stopBox = await page
    .getByRole("button", { name: /^Emergency stop/ })
    .boundingBox();
  expect(stopBox!.height).toBeGreaterThanOrEqual(44);
  expect(stopBox!.y + stopBox!.height).toBeLessThanOrEqual(844);
  const startBox = await page
    .getByRole("button", { name: "Start practice", exact: true })
    .boundingBox();
  expect(startBox!.x).toBeGreaterThanOrEqual(0);
  expect(startBox!.x + startBox!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/nerve-mobile.png",
    fullPage: true,
  });
});

test("bridge rejects cross-origin mutations and malformed approvals", async ({
  request,
}) => {
  const crossOrigin = await request.post("/api/session", {
    data: { mode: "practice", screenConsent: false },
    headers: { Origin: "https://untrusted.invalid" },
  });
  expect(crossOrigin.status()).toBe(403);
  const malformed = await request.post("/api/approve", {
    data: {},
    headers: { Origin: origin },
  });
  expect(malformed.status()).toBeGreaterThanOrEqual(400);
  expect(malformed.status()).toBeLessThan(500);
});

test("preferences persist locally and can be cleared", async ({ page }) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("checkbox", { name: /Larger text/ }).check();
  await page.getByRole("checkbox", { name: /Higher contrast/ }).check();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-large", "true");
  await expect(page.locator("html")).toHaveAttribute("data-contrast", "true");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Clear local preferences/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-large", "false");
  await expect(page.locator("html")).toHaveAttribute("data-contrast", "false");
});

test("export contains an audit record but no screenshot, webcam frames, or credential", async ({
  page,
  request,
}) => {
  await startPractice(page, request);
  await page.getByRole("tab", { name: /Session log/ }).click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export session", exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^nerve-session-\d+\.json$/);
  const filePath = await download.path();
  expect(filePath).toBeTruthy();
  const log = JSON.parse(await readFile(filePath!, "utf8"));
  expect(log.version).toBe(1);
  expect(log.mode).toBe("practice");
  expect(Array.isArray(log.events)).toBeTruthy();
  for (const key of [
    "screenshot",
    "screenshots",
    "frames",
    "video",
    "apiKey",
    "OPENAI_API_KEY",
  ]) {
    expect(log).not.toHaveProperty(key);
  }
  expect(JSON.stringify(log)).not.toContain("data:image/");
});

test("single-switch mode preserves spaces in an explicit intent field", async ({
  page,
  request,
}) => {
  await startPractice(page, request);
  await page
    .getByRole("button", { name: "Single switch", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Something else", exact: true })
    .click();
  const input = page.getByRole("textbox", { name: "Your intent", exact: true });
  await input.fill("Save");
  await input.press("Space");
  await input.pressSequentially("a note");
  await expect(input).toHaveValue("Save a note");
  expect((await state(request)).proposal).toBeNull();
});

test("one switch can select, confirm, and approve a complete practice task", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  await startPractice(page, request);
  await page
    .getByRole("button", { name: "Single switch", exact: true })
    .click();
  const selectScanned = async (id: string) => {
    const control = page.locator(`[data-scan-id="${id}"]`);
    await expect(control).toHaveAttribute("data-scanning", "true", {
      timeout: 25_000,
    });
    // Human-sized release interval, intentionally longer than switch repeat protection.
    await page.waitForTimeout(700);
    await expect(control).toHaveAttribute("data-scanning", "true", {
      timeout: 25_000,
    });
    await page.keyboard.press("Space");
  };
  await selectScanned("intent-0");
  await selectScanned("confirm-intent");
  await expect.poll(async () => (await state(request)).status).toBe("approval");
  for (let i = 0; i < 6; i++) {
    const current = await state(request);
    if (current.status === "completed") break;
    const proposalId = current.proposal?.id;
    expect(proposalId).toBeTruthy();
    await selectScanned("approve");
    await expect
      .poll(async () => {
        const next = await state(request);
        return (
          ["completed", "error", "stopped"].includes(next.status) ||
          (next.status === "approval" && next.proposal?.id !== proposalId)
        );
      })
      .toBeTruthy();
    const result = await state(request);
    expect(["approval", "completed"], result.message).toContain(result.status);
  }
  expect((await state(request)).status).toBe("completed");
  expect(String((await labState(request)).draft)).toContain("Alex");
});

test("paused input can be resumed with the same single switch", async ({
  page,
  request,
}) => {
  await startPractice(page, request);
  await page
    .getByRole("button", { name: "Single switch", exact: true })
    .click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const resume = page
    .getByTestId("computer-screen")
    .getByRole("button", { name: "Resume", exact: true });
  await expect(resume).toBeVisible();
  await expect(resume).toHaveAttribute("data-scanning", "true");
  await page.keyboard.press("Space");
  await expect(resume).toBeHidden();
});

test("the first switch signal is accepted before 650 ms while repeat protection stays active", async ({
  page,
  request,
}) => {
  await startPractice(page, request);
  // Generated clock fixture: first input must not be mistaken for a repeat of time zero.
  await page.evaluate(() =>
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => 100,
    }),
  );
  await page
    .getByRole("button", { name: "Single switch", exact: true })
    .click();
  await expect(page.locator('[data-scan-id="intent-0"]')).toHaveAttribute(
    "data-scanning",
    "true",
  );
  await page.keyboard.press("Space");
  const confirm = page.getByRole("button", {
    name: "Confirm intent",
    exact: true,
  });
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveAttribute("data-scanning", "true");
  await page.keyboard.press("Space");
  await expect(confirm).toBeVisible();
  expect((await state(request)).proposal).toBeNull();
});

for (const dialogType of ["Settings", "Camera"] as const) {
  test(`Emergency stop remains single-switch accessible inside ${dialogType}`, async ({
    page,
    request,
  }) => {
    await startPractice(page, request);
    await chooseIntent(page, request, "Archive message");
    const before = await labState(request);
    await page
      .getByRole("button", { name: "Single switch", exact: true })
      .click();
    await page.getByRole("button", { name: dialogType, exact: true }).click();
    const emergency = page
      .getByRole("dialog")
      .getByRole("button", { name: "Emergency stop", exact: true });
    await expect(emergency).toBeVisible();
    await expect(emergency).toHaveAttribute(
      dialogType === "Camera" ? "data-camera-highlight" : "data-scanning",
      "true",
    );
    expect(
      await emergency.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
        return hit === element || (hit !== null && element.contains(hit));
      }),
    ).toBeTruthy();
    await page.keyboard.press("Space");
    await expect
      .poll(async () => (await state(request)).status)
      .toBe("stopped");
    expect((await state(request)).proposal).toBeNull();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await labState(request)).toEqual(before);
  });
}

test("single-switch scanning reaches secondary navigation and modal consent without hidden targets", async ({
  page,
}) => {
  test.setTimeout(100_000);
  await page.evaluate(() =>
    localStorage.setItem("nerve.preferences", JSON.stringify({ scanMs: 900 })),
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Single switch", exact: true })
    .click();
  const select = async (control: ReturnType<Page["locator"]>) => {
    await page.waitForTimeout(700);
    await expect(control).toHaveAttribute("data-scanning", "true", {
      timeout: 30_000,
    });
    const unobscured = await control.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
      return hit === element || (hit !== null && element.contains(hit));
    });
    expect(
      unobscured,
      "The selected switch control must not be hidden behind the pinned stop bar.",
    ).toBeTruthy();
    await page.keyboard.press("Space");
  };
  await select(page.locator('[data-scan-id="help"]'));
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Small signals. Clear choices." }),
  ).toBeVisible();
  await select(page.getByRole("button", { name: "Close dialog", exact: true }));
  await expect(page.getByRole("dialog")).toBeHidden();
  await select(page.locator('[data-scan-id="connect-astra"]'));
  const consent = page.getByRole("checkbox");
  await select(consent);
  await expect(consent).toBeChecked();
  await select(page.getByRole("button", { name: "Close dialog", exact: true }));
  await select(page.locator('[data-scan-id="activity-tab"]'));
  await expect(page.getByRole("tab", { name: /Session log/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const downloaded = page.waitForEvent("download");
  await select(
    page.getByRole("button", { name: "Export session", exact: true }),
  );
  expect((await downloaded).suggestedFilename()).toMatch(
    /^nerve-session-\d+\.json$/,
  );
  await select(page.locator('[data-scan-id="workspace-tab"]'));
  await expect(page.getByRole("tab", { name: /Workspace/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("late and out-of-order state polls cannot restore an approval after Emergency stop", async ({
  page,
  request,
}) => {
  await startPractice(page, request);
  await chooseIntent(page, request, "Archive message");
  const before = await labState(request);
  const stale = await state(request);
  let reads = 0;
  let release!: () => void;
  const heldResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/state", async (route) => {
    reads++;
    if (reads === 1) await heldResponse;
    await route.fulfill({ json: stale });
  });
  try {
    await expect.poll(() => reads).toBe(1);
    await page.getByRole("button", { name: /^Emergency stop/ }).click();
    await expect
      .poll(async () => (await state(request)).status)
      .toBe("stopped");
    const stopped = await state(request);
    await expect(
      page.getByRole("button", { name: "Approve action", exact: true }),
    ).toBeHidden();
    release();
    // Subsequent old-revision polls also exercise the monotonic revision check.
    await expect.poll(() => reads).toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId("run-status")).toHaveText("Paused");
    await expect(page.locator(".session-message")).toContainText(
      stopped.message,
    );
    await expect(
      page.getByRole("button", { name: "Approve action", exact: true }),
    ).toBeHidden();
    expect(await labState(request)).toEqual(before);
  } finally {
    release();
    await page.unroute("**/api/state");
  }
});

test("gaze target geometry excludes covered and offscreen controls in a real browser", async ({
  page,
}) => {
  const counts = await page.evaluate(async () => {
    const modulePath = "/src/input-controls.ts";
    const { gazeTargets } = await import(modulePath);
    const button = document.createElement("button");
    const label = document.createElement("span");
    label.textContent = "Visible fixture";
    label.style.cssText = "display:block;width:100%;height:100%";
    button.append(label);
    button.dataset.scanId = "geometry-fixture";
    button.style.cssText =
      "position:fixed;top:100px;left:80px;width:160px;height:50px;z-index:10000";
    const cover = document.createElement("div");
    cover.style.cssText =
      "position:fixed;top:100px;left:80px;width:160px;height:50px;z-index:10001;background:white";
    document.body.append(button);
    try {
      const visible = gazeTargets([button]).length;
      document.body.append(cover);
      const covered = gazeTargets([button]).length;
      cover.remove();
      const uncovered = gazeTargets([button]).length;
      button.style.top = "-100px";
      const offscreen = gazeTargets([button]).length;
      return { visible, covered, uncovered, offscreen };
    } finally {
      button.remove();
      cover.remove();
    }
  });
  expect(counts).toEqual({
    visible: 1,
    covered: 0,
    uncovered: 1,
    offscreen: 0,
  });
});

test("automated accessibility checks pass on entry and setup dialogs", async ({
  page,
}) => {
  const analyze = async (label: string) => {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    await test
      .info()
      .attach(`axe-${label}`, {
        body: JSON.stringify(results, null, 2),
        contentType: "application/json",
      });
    expect
      .soft(
        results.violations.map((item) => ({
          id: item.id,
          impact: item.impact,
          targets: item.nodes.map((node) => node.target),
        })),
        label,
      )
      .toEqual([]);
  };
  await analyze("entry");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await analyze("settings");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Camera", exact: true }).click();
  await analyze("camera");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect Astra", exact: true })
    .click();
  await analyze("astra");
});

test("real local vision runtime initializes on a synthetic camera and releases its tracks", async () => {
  test.setTimeout(90_000);
  // Chromium generates the test video. These flags do not open the person's webcam.
  const browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  try {
    const context = await browser.newContext({
      permissions: ["camera"],
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    await context.addInitScript(() => {
      type SyntheticWindow = Window & {
        __nerveSyntheticStreams?: MediaStream[];
      };
      const scope = window as SyntheticWindow;
      scope.__nerveSyntheticStreams = [];
      const native = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await native(constraints);
        scope.__nerveSyntheticStreams!.push(stream);
        return stream;
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const externalRequests: string[] = [];
    const visionRequests: string[] = [];
    context.on("request", (request) => {
      const url = request.url();
      if (url.startsWith("http") && new URL(url).origin !== origin)
        externalRequests.push(url);
      if (url.includes("/vision/")) visionRequests.push(url);
    });
    await page.goto(origin);
    await page.getByRole("button", { name: "Camera", exact: true }).click();
    await page
      .getByRole("button", { name: "Enable camera", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Calibrate gaze", exact: true }),
    ).toBeEnabled({ timeout: 60_000 });
    expect(
      visionRequests.some((url) => url.endsWith("face_landmarker.task")),
    ).toBeTruthy();
    expect(visionRequests.some((url) => url.endsWith(".wasm"))).toBeTruthy();
    await expect(
      page.getByRole("button", { name: "Use calibrated input", exact: true }),
    ).toBeHidden();
    expect(externalRequests).toEqual([]);
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect
      .soft(
        accessibility.violations.map((item) => ({
          id: item.id,
          targets: item.nodes.map((node) => node.target),
        })),
      )
      .toEqual([]);
    await page
      .getByRole("button", { name: "Stop camera", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const streams =
            (window as Window & { __nerveSyntheticStreams?: MediaStream[] })
              .__nerveSyntheticStreams ?? [];
          return (
            streams.length > 0 &&
            streams.every((stream) =>
              stream.getTracks().every((track) => track.readyState === "ended"),
            )
          );
        }),
      )
      .toBeTruthy();
    // Exercise the actual calibration overlay with the generated pattern, not a human face.
    await page.getByRole("button", { name: "Camera", exact: true }).click();
    await page
      .getByRole("button", { name: "Enable camera", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Calibrate gaze", exact: true }),
    ).toBeEnabled({ timeout: 60_000 });
    await page
      .getByRole("button", { name: "Calibrate gaze", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Cancel calibration", exact: true }),
    ).toBeVisible();
    const emergency = page
      .getByRole("dialog")
      .getByRole("button", { name: "Emergency stop", exact: true });
    await expect(emergency).toHaveAttribute("data-camera-highlight", "true");
    const coveredTargets = await emergency.evaluate(
      (element, targets) => {
        const box = element.getBoundingClientRect();
        return targets.filter((point) => {
          const x = point.x * window.innerWidth,
            y = point.y * window.innerHeight;
          const radius = 14;
          return (
            x + radius >= box.left &&
            x - radius <= box.right &&
            y + radius >= box.top &&
            y - radius <= box.bottom
          );
        });
      },
      [...GAZE_TRAIN_TARGETS, ...GAZE_VALIDATION_TARGETS],
    );
    expect(
      coveredTargets,
      "Emergency stop must not obscure any training or held-out gaze marker.",
    ).toEqual([]);
    const stopBox = await emergency.boundingBox();
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    expect(stopBox!.y).toBeGreaterThanOrEqual(viewportHeight - 70);
    expect(stopBox!.y + stopBox!.height).toBeLessThanOrEqual(viewportHeight);
    expect(stopBox!.width).toBeLessThanOrEqual(240);
    await page.screenshot({ path: "test-results/nerve-calibration.png" });
    expect(
      await emergency.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
        return hit === element || (hit !== null && element.contains(hit));
      }),
    ).toBeTruthy();
    await page.keyboard.press("Space");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const streams =
            (window as Window & { __nerveSyntheticStreams?: MediaStream[] })
              .__nerveSyntheticStreams ?? [];
          return (
            streams.length === 2 &&
            streams.every((stream) =>
              stream.getTracks().every((track) => track.readyState === "ended"),
            )
          );
        }),
      )
      .toBeTruthy();
    expect(externalRequests).toEqual([]);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("closing camera setup releases a stream granted after cancellation", async ({
  page,
}) => {
  await page.evaluate(() => {
    type CameraRaceWindow = Window & {
      __resolveCamera?: () => void;
      __lateTrackStopped?: boolean;
    };
    const scope = window as CameraRaceWindow;
    scope.__lateTrackStopped = false;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: () =>
        new Promise<MediaStream>((resolve) => {
          scope.__resolveCamera = () =>
            resolve({
              getTracks: () => [
                {
                  stop: () => {
                    scope.__lateTrackStopped = true;
                  },
                },
              ],
            } as unknown as MediaStream);
        }),
    });
  });
  await page.getByRole("button", { name: "Camera", exact: true }).click();
  await page
    .getByRole("button", { name: "Enable camera", exact: true })
    .click();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.evaluate(() =>
    (window as Window & { __resolveCamera?: () => void }).__resolveCamera?.(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __lateTrackStopped?: boolean })
            .__lateTrackStopped,
      ),
    )
    .toBeTruthy();
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("an active workspace and its approval controls pass automated accessibility checks", async ({
  page,
  request,
}) => {
  await startPractice(page, request);
  await chooseIntent(page, request, "Draft a reply");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  await test
    .info()
    .attach("axe-approval", {
      body: JSON.stringify(results, null, 2),
      contentType: "application/json",
    });
  expect(
    results.violations.map((item) => ({
      id: item.id,
      targets: item.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
});
