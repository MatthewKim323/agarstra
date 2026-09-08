import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  GAZE_ZONES,
  gazeZoneCenter,
  type GazeZone,
} from "../../src/core/gaze-activation";

const FIXTURE = `
import React from "/node_modules/.vite/deps/react.js";
import ReactDOM from "/node_modules/.vite/deps/react-dom_client.js";
import {EyesWorkspace} from "/src/components/EyesWorkspace.tsx";
import "/src/styles.css";
window.__eyes = {events: [], checks: [], emit: null, change: null};
function Fixture() {
  const [observation, setObservation] = React.useState(null);
  const [view, setView] = React.useState({stage: "choice", primary: "Choose draft", secondary: "Next choice", active: true, suspended: false, disabled: false});
  window.__eyes.emit = setObservation;
  window.__eyes.change = (patch) => setView((current) => ({...current, ...patch}));
  const select = (name) => {
    window.__eyes.events.push(name);
    if (name === "primary") setView((current) => ({...current, stage: current.stage + ":next", primary: "Confirm next stage"}));
  };
  return React.createElement(EyesWorkspace, {
    observation, stageKey: view.stage, title: "Choose your next action", active: view.active, suspended: view.suspended,
    description: "Look at a large choice, then hold. No facial gesture is needed.",
    primary: {label: view.primary, description: "Read the message and prepare a draft. Nothing is sent.", disabled: view.disabled, onSelect: () => select("primary")},
    secondary: {label: view.secondary, description: "Show another available choice.", onSelect: () => select("secondary")},
    onStop: () => select("stop"), onExit: () => select("exit"), onRecalibrate: () => select("setup"),
    onCheckPassed: (results) => window.__eyes.checks.push(results)
  }, React.createElement("p", null, "Screen preview stays in the neutral reading area."));
}
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(Fixture));
`;

type FixtureWindow = Window & {
  __eyes?: {
    events: string[];
    checks: unknown[];
    emit: (value: {
      x: number;
      y: number;
      timestamp: number;
      quality: number;
      gesture: false;
      features: number[];
    }) => void;
    change: (patch: Record<string, unknown>) => void;
  };
};

async function boot(page: Page) {
  await page.clock.install({ time: new Date("2026-09-08T00:00:00Z") });
  await page.addInitScript(() => {
    if (navigator.mediaDevices)
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        value: () => {
          throw new Error("No camera access in synthetic eye tests");
        },
      });
  });
  const requests: string[] = [];
  await page.route("**/api/**", async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  await page.route(/\/src\/main\.tsx(?:\?.*)?$/, async (route) => {
    const original = await (await route.fetch()).text();
    let body = FIXTURE;
    for (const dependency of ["react", "react-dom_client"]) {
      const path = `/node_modules/.vite/deps/${dependency}.js`;
      const resolved = original.match(
        new RegExp(`${path.replaceAll(".", "\\.")}[^\"']*`),
      )?.[0];
      if (resolved) body = body.replace(path, resolved);
    }
    await route.fulfill({ contentType: "text/javascript", body });
  });
  await page.goto("/");
  await expect(page.getByTestId("eyes-workspace")).toBeVisible();
  await page.clock.pauseAt(
    new Date(await page.evaluate(() => Date.now() + 100)),
  );
  return requests;
}

async function emit(page: Page, zone: GazeZone, latency = 0) {
  await page.evaluate(
    ({ point, lag }) => {
      (window as FixtureWindow).__eyes!.emit({
        ...point,
        timestamp: performance.now() - lag,
        quality: 1,
        gesture: false,
        features: [],
      });
    },
    { point: gazeZoneCenter(zone), lag: latency },
  );
}

async function hold(page: Page, zone: GazeZone, duration: number, latency = 0) {
  for (let elapsed = 0; elapsed < duration; elapsed += 333) {
    await emit(page, zone, latency);
    await page.clock.runFor(333);
  }
}

async function passCheck(page: Page, latency = 0) {
  for (let frame = 0; frame < 70; frame++) {
    if (
      (await page
        .getByTestId("eyes-workspace")
        .getAttribute("data-gaze-check")) === "passed"
    )
      return;
    const target = page.locator('[data-check-target="true"]');
    await expect(target).toHaveCount(1);
    await emit(
      page,
      (await target.getAttribute("data-gaze-zone")) as GazeZone,
      latency,
    );
    await page.clock.runFor(333);
  }
  await expect(page.getByTestId("eyes-workspace")).toHaveAttribute(
    "data-gaze-check",
    "passed",
  );
}

async function events(page: Page) {
  return page.evaluate(() => (window as FixtureWindow).__eyes!.events);
}

test("gaze alone checks real zones and selects once per neutral rearm, including slow inference", async ({
  page,
}) => {
  const requests = await boot(page);
  await passCheck(page, 300);
  expect(await events(page)).toEqual([]);
  await hold(page, "stop", 2000, 300);
  expect(await events(page)).toEqual([]);
  await hold(page, "primary", 2000, 300);
  expect(await events(page)).toEqual([]);
  await hold(page, "neutral", 1000, 300);
  await hold(page, "primary", 2000, 300);
  expect(await events(page)).toEqual(["primary"]);
  await hold(page, "primary", 2000, 300);
  expect(await events(page)).toEqual(["primary"]);
  await hold(page, "neutral", 1000, 300);
  await hold(page, "primary", 2000, 300);
  expect(await events(page)).toEqual(["primary", "primary"]);
  await hold(page, "stop", 1332, 300);
  expect(await events(page)).toEqual(["primary", "primary", "stop"]);
  expect(requests).toEqual([]);
});

test("changed or disabled controls cannot inherit an in-progress hold", async ({
  page,
}) => {
  await boot(page);
  await passCheck(page);
  await hold(page, "neutral", 1000);
  await hold(page, "primary", 666);
  await page.evaluate(() =>
    (window as FixtureWindow).__eyes!.change({ disabled: true }),
  );
  await hold(page, "primary", 666);
  await page.evaluate(() =>
    (window as FixtureWindow).__eyes!.change({ disabled: false }),
  );
  await hold(page, "primary", 2000);
  expect(await events(page)).toEqual([]);
  await hold(page, "neutral", 1000);
  await hold(page, "primary", 666);
  await page.evaluate(() =>
    (window as FixtureWindow).__eyes!.change({ primary: "A different goal" }),
  );
  await hold(page, "primary", 2000);
  expect(await events(page)).toEqual([]);
  await page.evaluate(() =>
    (window as FixtureWindow).__eyes!.change({ active: false }),
  );
  await expect(page.getByTestId("eyes-workspace")).toHaveAttribute(
    "data-gaze-check",
    "inactive",
  );
  await hold(page, "neutral", 1000);
  await hold(page, "primary", 2000);
  expect(await events(page)).toEqual([]);
});

test("attention suspension preserves the passed check and requires fresh neutral rearm", async ({
  page,
}) => {
  await boot(page);
  await passCheck(page);
  await hold(page, "neutral", 1000);
  await hold(page, "primary", 666);
  await page.evaluate(() =>
    (window as FixtureWindow).__eyes!.change({ suspended: true }),
  );
  await expect(page.getByTestId("eyes-workspace")).toBeHidden();
  await hold(page, "primary", 2000);
  expect(await events(page)).toEqual([]);
  await page.evaluate(() =>
    (window as FixtureWindow).__eyes!.change({ suspended: false }),
  );
  await expect(page.getByTestId("eyes-workspace")).toHaveAttribute(
    "data-gaze-check",
    "passed",
  );
  await hold(page, "primary", 2000);
  expect(await events(page)).toEqual([]);
  await hold(page, "neutral", 1000);
  await hold(page, "primary", 2000);
  expect(await events(page)).toEqual(["primary"]);
});

test("a failed or undersized control check keeps computer actions disabled", async ({
  page,
}) => {
  await boot(page);
  await hold(page, "neutral", 10_000);
  await expect(page.getByTestId("eyes-workspace")).toHaveAttribute(
    "data-gaze-check",
    "failed",
  );
  await expect(page.locator('[data-gaze-zone="primary"]')).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Return to gaze setup", exact: true }),
  ).toBeVisible();
  expect(await events(page)).toEqual([]);
  await page.setViewportSize({ width: 800, height: 600 });
  await expect(page.getByTestId("eyes-workspace")).toHaveAttribute(
    "data-gaze-check",
    "unsupported",
  );
  await expect(page.locator('[data-gaze-zone="primary"]')).toBeDisabled();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByTestId("eyes-workspace")).toHaveAttribute(
    "data-gaze-check",
    "checking",
  );
});

test("visible control geometry matches the hit zones and the surface passes accessibility checks", async ({
  page,
}, testInfo) => {
  await boot(page);
  await passCheck(page);
  for (const zone of Object.keys(GAZE_ZONES) as GazeZone[]) {
    const actual = await page
      .locator(`[data-gaze-zone="${zone}"]`)
      .boundingBox();
    const expected = GAZE_ZONES[zone];
    expect(actual).not.toBeNull();
    expect(actual!.x / 1440).toBeCloseTo(expected.x, 3);
    expect(actual!.y / 1000).toBeCloseTo(expected.y, 3);
    expect(actual!.width / 1440).toBeCloseTo(expected.width, 3);
    expect(actual!.height / 1000).toBeCloseTo(expected.height, 3);
  }
  await page.clock.resume();
  const results = await new AxeBuilder({ page })
    .include(".eyes-workspace")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("nerve-eyes-workspace.png"),
  });
});
