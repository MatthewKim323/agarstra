import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import type { Candidate, SessionState } from "../../shared/types";

const PRIVATE_URL = "https://private.example/inbox/customer-482-secret";
const PRIVATE_TITLE = "Private customer note 482";
const PRIVATE_GOAL = "Save the private customer-482 access instructions";
const LABELS = ["Draft a reply", "Save a note", "Archive message"];
const CANDIDATES: Candidate[] = LABELS.map((label, index) => ({
  id: ["reply", "note", "archive"][index],
  label,
  description: `Private example ${index}`,
  goal: `${PRIVATE_GOAL} ${index}`,
  probability: [0.45, 0.35, 0.2][index],
  risk: index === 1 ? "low" : "confirm",
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Every bridge request is intercepted, including mutations and state polling. */
async function mockBridge(page: Page, mode: SessionState["mode"] = "practice") {
  let revision = 1;
  let state: SessionState = {
    mode,
    status: "idle",
    model: "test-model",
    configured: mode === "astra",
    screenshot:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    url: PRIVATE_URL,
    title: PRIVATE_TITLE,
    width: 1280,
    height: 800,
    revision,
    proposal: null,
    events: [],
    message: "Mock workspace ready.",
    goal: "",
    steps: 0,
    maxSteps: 20,
    screenConsent: mode === "astra",
  };
  const bridge = {
    requests: [] as { path: string; body: Record<string, unknown> }[],
    unexpected: [] as string[],
    external: [] as string[],
    holdIntent: null as ReturnType<typeof deferred> | null,
    holdCandidates: null as ReturnType<typeof deferred> | null,
    intentFailure: false,
    publishAcceptedBeforeReply: false,
    acceptedPolls: 0,
    candidates: CANDIDATES,
    count(path: string) {
      return this.requests.filter((request) => request.path === path).length;
    },
  };
  await page.addInitScript(() => {
    const scope = window as Window & { __intentCameraRequests?: number };
    scope.__intentCameraRequests = 0;
    if (!navigator.mediaDevices) return;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        scope.__intentCameraRequests = (scope.__intentCameraRequests ?? 0) + 1;
        throw new DOMException("Camera disabled by test", "NotAllowedError");
      },
    });
  });
  page.on("request", (request) => {
    if (
      request.url().startsWith("http") &&
      new URL(request.url()).origin !== new URL(page.url()).origin
    )
      bridge.external.push(request.url());
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (route.request().postDataJSON() ?? {}) as Record<
      string,
      unknown
    >;
    bridge.requests.push({ path, body });
    if (path === "/api/state") {
      if (state.status === "approval") bridge.acceptedPolls++;
      await route.fulfill({ json: state });
      return;
    }
    if (path === "/api/candidates") {
      const response = {
        candidates: structuredClone(bridge.candidates),
        source: state.mode,
        state: structuredClone(state),
      };
      if (bridge.holdCandidates) await bridge.holdCandidates.promise;
      await route.fulfill({ json: response });
      return;
    }
    if (path === "/api/intent") {
      if (bridge.intentFailure) {
        await route.fulfill({
          status: 409,
          json: { error: "The screen changed. Choose the intent again." },
        });
        return;
      }
      const accepted: SessionState = {
        ...state,
        revision: ++revision,
        status: "approval",
        goal: String(body.goal),
        message: "Intent accepted. Action needs approval.",
        proposal: {
          id: `proposal-${revision}`,
          summary: "Save the requested draft",
          actions: [{ type: "click", x: 50, y: 50 }],
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          revision,
          safetyWarnings: [],
        },
      };
      if (bridge.publishAcceptedBeforeReply) state = accepted;
      if (bridge.holdIntent) await bridge.holdIntent.promise;
      if (state.status !== "stopped") state = accepted;
      await route.fulfill({ json: accepted });
      return;
    }
    if (path === "/api/stop") {
      state = {
        ...state,
        status: "stopped",
        revision: ++revision,
        proposal: null,
        message: "Stopped by the user.",
      };
      await route.fulfill({ json: state });
      return;
    }
    bridge.unexpected.push(path);
    await route.fulfill({
      status: 500,
      json: { error: `Unexpected bridge request: ${path}` },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("img", { name: "Current isolated browser screenshot" }),
  ).toBeVisible();
  if (mode === "practice")
    await expect(page.locator('[data-scan-id="intent-0"]')).toBeEnabled();
  // Ignore the navigation request itself, which precedes the document URL update.
  bridge.external.length = 0;
  return bridge;
}

async function openLearning(page: Page) {
  await page
    .getByRole("button", { name: "Intent learning", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Learn your intent" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function learnedCount(page: Page, count: number) {
  await expect(page.getByTestId("intent-learned-count")).toHaveText(
    String(count),
  );
}

async function teach(page: Page, label = "Save a note") {
  const dialog = page.getByRole("dialog", { name: "Learn your intent" });
  await dialog
    .getByRole("button", { name: "Teach without running", exact: true })
    .click();
  await dialog.getByRole("button", { name: label, exact: true }).click();
  await dialog
    .getByRole("button", { name: "Save example", exact: true })
    .click();
  await expect(
    dialog.getByText("Example saved.", { exact: true }),
  ).toBeVisible();
}

async function closeLearning(page: Page) {
  await page
    .getByRole("dialog", { name: "Learn your intent" })
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
}

async function storage(page: Page) {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
    ),
  );
}

test("teaching is explicit, local, and session-only by default", async ({
  page,
}) => {
  const bridge = await mockBridge(page);
  const dialog = await openLearning(page);
  await expect(
    dialog.getByRole("checkbox", {
      name: "Learn from confirmed choices",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("checkbox", {
      name: "Remember on this device",
      exact: true,
    }),
  ).not.toBeChecked();
  await learnedCount(page, 0);
  await dialog
    .getByRole("button", { name: "Teach without running", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Save example", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Archive message", exact: true })
    .click();
  await learnedCount(page, 0);
  await dialog
    .getByRole("button", { name: "Save example", exact: true })
    .click();
  await expect(
    dialog.getByText("Example saved.", { exact: true }),
  ).toBeVisible();
  await learnedCount(page, 1);
  expect(bridge.requests.every(({ path }) => path === "/api/state")).toBe(true);
  expect(bridge.unexpected).toEqual([]);
  expect(bridge.external).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __intentCameraRequests?: number })
          .__intentCameraRequests,
    ),
  ).toBe(0);
  expect((await storage(page))["nerve.intent-learning.v1"]).toBeUndefined();
  await page.reload();
  await openLearning(page);
  await learnedCount(page, 0);
});

test("a frozen check is scored without training, including none-of-these", async ({
  page,
}) => {
  const bridge = await mockBridge(page);
  const dialog = await openLearning(page);
  await dialog
    .getByRole("button", { name: "Check without learning", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Draft a reply", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Score this check", exact: true })
    .click();
  await expect(
    dialog.getByText("Check scored. The model was not trained.", {
      exact: true,
    }),
  ).toBeVisible();
  await learnedCount(page, 0);
  await expect(page.getByTestId("intent-check-count")).toHaveText("1");
  await dialog
    .getByRole("button", { name: "Another check", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "None of these / just reading", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Score this check", exact: true })
    .click();
  await learnedCount(page, 0);
  await expect(page.getByTestId("intent-check-count")).toHaveText("2");
  expect(bridge.requests.every(({ path }) => path === "/api/state")).toBe(true);
});

test("preview and back are unlabeled, accepted confirmation learns once, cancellation does not relabel", async ({
  page,
}) => {
  const bridge = await mockBridge(page);
  await page.locator('[data-scan-id="intent-0"]').click();
  await page
    .getByRole("button", { name: "Choose something else", exact: true })
    .click();
  await openLearning(page);
  await learnedCount(page, 0);
  await closeLearning(page);
  expect(bridge.count("/api/intent")).toBe(0);
  await page.locator('[data-scan-id="intent-1"]').click();
  await page
    .getByRole("button", { name: "Confirm intent", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Approve action", exact: true }),
  ).toBeVisible();
  expect(bridge.count("/api/intent")).toBe(1);
  expect(
    bridge.requests.find(({ path }) => path === "/api/intent")?.body
      .expectedRevision,
  ).toBe(1);
  await openLearning(page);
  await learnedCount(page, 1);
  await closeLearning(page);
  await page
    .getByRole("button", { name: "Cancel action", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Approve action", exact: true }),
  ).toBeHidden();
  await openLearning(page);
  await learnedCount(page, 1);
  expect(bridge.count("/api/approve")).toBe(0);
  expect(bridge.unexpected).toEqual([]);
});

test("rejected intent requests never become positive training examples", async ({
  page,
}) => {
  const bridge = await mockBridge(page);
  bridge.intentFailure = true;
  await page.locator('[data-scan-id="intent-0"]').click();
  await page
    .getByRole("button", { name: "Confirm intent", exact: true })
    .click();
  await expect(
    page.getByText("The screen changed. Choose the intent again.", {
      exact: true,
    }),
  ).toBeVisible();
  await openLearning(page);
  await learnedCount(page, 0);
  expect(bridge.count("/api/intent")).toBe(1);
});

test("opt-in persistence survives reload and forget clears it without storing task content", async ({
  page,
}) => {
  await mockBridge(page);
  const dialog = await openLearning(page);
  await dialog
    .getByRole("checkbox", { name: "Remember on this device", exact: true })
    .check();
  await teach(page);
  await learnedCount(page, 1);
  const saved = await storage(page);
  expect(Object.keys(saved).some((key) => /intent/i.test(key))).toBe(true);
  const serialized = JSON.stringify(saved);
  for (const value of [
    PRIVATE_URL,
    PRIVATE_TITLE,
    PRIVATE_GOAL,
    ...LABELS,
    "data:image/",
  ])
    expect(serialized).not.toContain(value);
  await page.reload();
  await openLearning(page);
  await learnedCount(page, 1);
  await expect(
    page.getByRole("checkbox", {
      name: "Remember on this device",
      exact: true,
    }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "Forget learned intent", exact: true })
    .click();
  await learnedCount(page, 0);
  await page.reload();
  await openLearning(page);
  await learnedCount(page, 0);
});

test("measurement export contains aggregates without private text or model weights", async ({
  page,
}) => {
  const bridge = await mockBridge(page);
  await openLearning(page);
  await teach(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export intent measurements", exact: true })
    .click();
  const download = await downloaded;
  const path = await download.path();
  expect(path).toBeTruthy();
  const report = JSON.parse(await readFile(path!, "utf8"));
  const serialized = JSON.stringify(report);
  for (const value of [
    PRIVATE_URL,
    PRIVATE_TITLE,
    PRIVATE_GOAL,
    ...LABELS,
    "data:image/",
    '"weights"',
    '"frames"',
  ])
    expect(serialized).not.toContain(value);
  expect(typeof report).toBe("object");
  expect(
    bridge.requests.every(
      ({ path: requestPath }) => requestPath === "/api/state",
    ),
  ).toBe(true);
});

test("turning persistence off removes the model even when storage writes fail", async ({
  page,
}) => {
  await mockBridge(page);
  const dialog = await openLearning(page);
  await dialog
    .getByRole("checkbox", { name: "Remember on this device", exact: true })
    .check();
  await teach(page);
  expect((await storage(page))["nerve.intent-learning.v1"]).toBeTruthy();
  await page.evaluate(() => {
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value: () => {
        throw new DOMException("Storage full", "QuotaExceededError");
      },
    });
  });
  await dialog
    .getByRole("checkbox", { name: "Remember on this device", exact: true })
    .uncheck();
  await expect
    .poll(async () => (await storage(page))["nerve.intent-learning.v1"])
    .toBeUndefined();
  expect((await storage(page))["nerve.intent-options.v1"]).toBeUndefined();
  await page.reload();
  await openLearning(page);
  await learnedCount(page, 0);
  await expect(
    page.getByRole("checkbox", {
      name: "Remember on this device",
      exact: true,
    }),
  ).not.toBeChecked();
});

test("an accepted state poll before the confirmation response does not lose or duplicate its label", async ({
  page,
}) => {
  const bridge = await mockBridge(page);
  const gate = deferred();
  bridge.holdIntent = gate;
  bridge.publishAcceptedBeforeReply = true;
  try {
    await page.locator('[data-scan-id="intent-0"]').click();
    await page
      .getByRole("button", { name: "Confirm intent", exact: true })
      .click();
    await expect.poll(() => bridge.acceptedPolls).toBeGreaterThan(0);
    await openLearning(page);
    await learnedCount(page, 0);
    await closeLearning(page);
    const response = page.waitForResponse("**/api/intent");
    gate.resolve();
    await response;
    await expect(
      page.getByRole("button", { name: "Approve action", exact: true }),
    ).toBeVisible();
    await openLearning(page);
    await learnedCount(page, 1);
    const polls = bridge.acceptedPolls;
    await expect.poll(() => bridge.acceptedPolls).toBeGreaterThan(polls);
    await learnedCount(page, 1);
    expect(bridge.count("/api/intent")).toBe(1);
  } finally {
    gate.resolve();
  }
});

test("an existing Astra session cannot teach from default practice candidates", async ({
  page,
}) => {
  const bridge = await mockBridge(page, "astra");
  for (let index = 0; index < LABELS.length; index++)
    await expect(
      page.locator(`[data-scan-id="intent-${index}"]`),
    ).toBeDisabled();
  const dialog = await openLearning(page);
  await learnedCount(page, 0);
  await expect(
    dialog.getByRole("button", { name: "Teach without running", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Check without learning", exact: true }),
  ).toBeDisabled();
  await closeLearning(page);
  await page
    .getByRole("button", { name: "Read this screen", exact: true })
    .click();
  await expect(page.locator('[data-scan-id="intent-0"]')).toBeEnabled();
  await openLearning(page);
  await teach(page);
  await learnedCount(page, 1);
  expect(bridge.count("/api/candidates")).toBe(1);
  expect(bridge.count("/api/intent")).toBe(0);
});

test("late suggestions cannot replace the candidate set after Emergency stop", async ({
  page,
}) => {
  const bridge = await mockBridge(page);
  bridge.candidates = [
    { ...CANDIDATES[0], id: "stale", label: "Stale suggestion" },
  ];
  const gate = deferred();
  bridge.holdCandidates = gate;
  try {
    await page
      .getByRole("button", { name: "Read this screen", exact: true })
      .click();
    await expect.poll(() => bridge.count("/api/candidates")).toBe(1);
    await page.getByRole("button", { name: /^Emergency stop/ }).click();
    await expect.poll(() => bridge.count("/api/stop")).toBe(1);
    await expect(page.getByTestId("run-status")).toHaveText("Paused");
    const response = page.waitForResponse("**/api/candidates");
    gate.resolve();
    await response;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect(page.locator(".candidate strong")).toHaveText(LABELS);
    await expect(
      page.getByText("Stale suggestion", { exact: true }),
    ).toBeHidden();
  } finally {
    gate.resolve();
  }
});

test("late confirmation after Emergency stop neither trains nor restores approval", async ({
  page,
}) => {
  const bridge = await mockBridge(page);
  const gate = deferred();
  bridge.holdIntent = gate;
  try {
    await page.locator('[data-scan-id="intent-0"]').click();
    await page
      .getByRole("button", { name: "Confirm intent", exact: true })
      .click();
    await expect.poll(() => bridge.count("/api/intent")).toBe(1);
    await page.getByRole("button", { name: /^Emergency stop/ }).click();
    await expect(page.getByTestId("run-status")).toHaveText("Paused");
    const response = page.waitForResponse("**/api/intent");
    gate.resolve();
    await response;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect(
      page.getByRole("button", { name: "Approve action", exact: true }),
    ).toBeHidden();
    await openLearning(page);
    await learnedCount(page, 0);
    expect(bridge.count("/api/approve")).toBe(0);
  } finally {
    gate.resolve();
  }
});

test("a custom goal supplies feedback only when its request is accepted", async ({
  page,
}) => {
  const bridge = await mockBridge(page);
  await page
    .getByRole("button", { name: "Something else", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Your intent", exact: true })
    .fill(PRIVATE_GOAL);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await openLearning(page);
  await learnedCount(page, 0);
  await closeLearning(page);
  expect(bridge.count("/api/intent")).toBe(0);
  await page
    .getByRole("button", { name: "Something else", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Your intent", exact: true })
    .fill(PRIVATE_GOAL);
  await page
    .getByRole("button", { name: "Use this intent", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Approve action", exact: true }),
  ).toBeVisible();
  await openLearning(page);
  await learnedCount(page, 1);
  expect(
    bridge.requests.find(({ path }) => path === "/api/intent")?.body.goal,
  ).toBe(PRIVATE_GOAL);
});

test("live pointer attention keeps targets stable and never supplies training labels", async ({
  page,
}) => {
  const bridge = await mockBridge(page);
  for (const index of [2, 0, 1]) {
    const bounds = await page
      .locator(`[data-scan-id="intent-${index}"]`)
      .boundingBox();
    expect(bounds).toBeTruthy();
    for (let step = 0; step < 5; step++) {
      await page.mouse.move(
        bounds!.x + bounds!.width / 2 + step,
        bounds!.y + bounds!.height / 2,
      );
      await page.waitForTimeout(80);
    }
    await expect(page.locator(".candidate strong")).toHaveText(LABELS);
  }
  await openLearning(page);
  await learnedCount(page, 0);
  expect(bridge.count("/api/intent")).toBe(0);
  expect(bridge.count("/api/approve")).toBe(0);
});

test("one switch can teach and check through dynamically added dialog controls", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-08T00:00:00Z") });
  await page.addInitScript(() => {
    localStorage.setItem("nerve.preferences", JSON.stringify({ scanMs: 900 }));
  });
  const bridge = await mockBridge(page);
  await page.clock.pauseAt(new Date("2026-09-08T00:02:00Z"));
  await page
    .getByRole("button", { name: "Single switch", exact: true })
    .click();
  const selectWithSwitch = async (control: Locator) => {
    for (let index = 0; index < 50; index++) {
      if ((await control.getAttribute("data-scanning")) === "true") {
        await page.keyboard.press("Space");
        // Advance beyond repeat suppression before the next user signal.
        await page.clock.runFor(700);
        return;
      }
      await page.clock.runFor(900);
    }
    throw new Error(
      `Single-switch scan never reached ${await control.innerText()}`,
    );
  };
  await selectWithSwitch(
    page.getByRole("button", { name: "Intent learning", exact: true }),
  );
  const dialog = page.getByRole("dialog", { name: "Learn your intent" });
  await expect(dialog).toBeVisible();
  await selectWithSwitch(
    dialog.getByRole("button", { name: "Teach without running", exact: true }),
  );
  await selectWithSwitch(
    dialog.getByRole("button", { name: "Save a note", exact: true }),
  );
  await selectWithSwitch(
    dialog.getByRole("button", { name: "Save example", exact: true }),
  );
  await learnedCount(page, 1);
  await selectWithSwitch(
    dialog.getByRole("button", { name: "Check without learning", exact: true }),
  );
  await selectWithSwitch(
    dialog.getByRole("button", {
      name: "None of these / just reading",
      exact: true,
    }),
  );
  await selectWithSwitch(
    dialog.getByRole("button", { name: "Score this check", exact: true }),
  );
  await learnedCount(page, 1);
  await expect(page.getByTestId("intent-check-count")).toHaveText("1");
  const scanIds = await dialog
    .locator("[data-scan-id]")
    .evaluateAll((controls) =>
      controls.map((control) => (control as HTMLElement).dataset.scanId),
    );
  expect(new Set(scanIds).size).toBe(scanIds.length);
  expect(bridge.count("/api/intent")).toBe(0);
  expect(bridge.count("/api/approve")).toBe(0);
});

test("intent learning and its active trial pass automated accessibility checks", async ({
  page,
}, testInfo) => {
  await mockBridge(page);
  const dialog = await openLearning(page);
  for (const phase of ["setup", "trial", "result"] as const) {
    if (phase === "trial")
      await dialog
        .getByRole("button", { name: "Teach without running", exact: true })
        .click();
    if (phase === "result") {
      await dialog
        .getByRole("button", { name: "Save a note", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "Save example", exact: true })
        .click();
    }
    const results = await new AxeBuilder({ page })
      .include("dialog[open]")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    await test.info().attach(`axe-intent-${phase}`, {
      body: JSON.stringify(results, null, 2),
      contentType: "application/json",
    });
    expect(
      results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
  }
  await dialog.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: testInfo.outputPath("nerve-intent-learning.png"),
    fullPage: true,
  });
});
