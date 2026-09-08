import { expect, test, type Page } from "@playwright/test";

const SCREEN = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#f4f7ed"/><rect x="50" y="50" width="450" height="600" fill="#d8e5c8"/><text x="90" y="130" font-size="40">Read this message</text><rect x="600" y="50" width="500" height="250" fill="#fff"/><text x="640" y="130" font-size="40">My notes</text></svg>')}`;
const FIXTURE = `
import React from "/node_modules/.vite/deps/react.js";
import ReactDOM from "/node_modules/.vite/deps/react-dom_client.js";
import {GazeAttentionView} from "/src/components/GazeAttentionView.tsx";
import "/src/styles.css";
window.__attention = {points: [], events: [], emit: null};
function Fixture() {
  const [observation, setObservation] = React.useState(null);
  window.__attention.emit = setObservation;
  return React.createElement(GazeAttentionView, { observation, screenshot: ${JSON.stringify(SCREEN)}, screenWidth: 1200, screenHeight: 800, active: true,
    onAttention: point => window.__attention.points.push(point),
    onStop: () => window.__attention.events.push("stop"),
    onBack: () => window.__attention.events.push("back"),
    onShowChoices: () => window.__attention.events.push("choices") });
}
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(Fixture));
`;

type AttentionWindow = Window & {
  __attention: {
    points: { x: number; y: number }[];
    events: string[];
    emit: (observation: unknown) => void;
  };
};

async function boot(page: Page) {
  const requests: string[] = [];
  await page.clock.install();
  await page.addInitScript(() => {
    if (navigator.mediaDevices)
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        value: () => {
          throw new Error("Camera must not be opened by attention view");
        },
      });
  });
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
        new RegExp(`${path.replaceAll(".", "\\.")}[^"']*`),
      )?.[0];
      if (resolved) body = body.replace(path, resolved);
    }
    await route.fulfill({ contentType: "text/javascript", body });
  });
  await page.goto("/");
  await expect(page.getByTestId("gaze-attention-view")).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(
    "Hold your gaze on one area. Nerve will suggest what to do next.",
  );
  await page.clock.pauseAt(
    new Date(await page.evaluate(() => Date.now() + 400)),
  );
  return requests;
}

async function look(
  page: Page,
  x: number,
  y: number,
  quality = 1,
  latency = 300,
) {
  await page.evaluate(
    ({ x, y, quality, latency }) => {
      const img = document.querySelector<HTMLImageElement>(
        ".gaze-attention-screen",
      )!;
      const r = img.getBoundingClientRect();
      const scale = Math.min(
        r.width / img.naturalWidth,
        r.height / img.naturalHeight,
      );
      const width = img.naturalWidth * scale,
        height = img.naturalHeight * scale;
      const px = r.x + (r.width - width) / 2 + x * width,
        py = r.y + (r.height - height) / 2 + y * height;
      (window as unknown as AttentionWindow).__attention.emit({
        x: px / innerWidth,
        y: py / innerHeight,
        quality,
        timestamp: performance.now() - latency,
        features: [],
        gesture: false,
      });
    },
    { x, y, quality, latency },
  );
  await page.clock.runFor(333);
}

test("steady gaze maps image content once without camera, intent labels, or action requests", async ({
  page,
}, testInfo) => {
  const requests = await boot(page);
  await look(page, 0.25, 0.7);
  await look(page, 0.25, 0.7);
  await look(page, 0.25, 0.7);
  expect(
    await page.evaluate(
      () => (window as unknown as AttentionWindow).__attention.points,
    ),
  ).toEqual([]);
  await look(page, 0.25, 0.7);
  const points = await page.evaluate(
    () => (window as unknown as AttentionWindow).__attention.points,
  );
  expect(points).toHaveLength(1);
  expect(points[0].x).toBeCloseTo(0.25, 6);
  expect(points[0].y).toBeCloseTo(0.7, 6);
  for (let i = 0; i < 5; i++) await look(page, 0.8, 0.3);
  expect(
    await page.evaluate(
      () => (window as unknown as AttentionWindow).__attention.points,
    ),
  ).toHaveLength(1);
  expect(
    await page.evaluate(
      () => (window as unknown as AttentionWindow).__attention.events,
    ),
  ).toEqual([]);
  expect(requests).toEqual([]);
  await page.clock.resume();
  await page.screenshot({
    path: testInfo.outputPath("nerve-gaze-attention.png"),
  });
});

test("invalid and moving gaze never becomes intent; timeout returns to choices once", async ({
  page,
}) => {
  await boot(page);
  await look(page, 0.2, 0.3);
  await look(page, 0.2, 0.3);
  await look(page, 0.2, 0.3, 0);
  for (let i = 0; i < 30; i++) await look(page, i % 2 ? 0.2 : 0.8, 0.5);
  expect(
    await page.evaluate(
      () => (window as unknown as AttentionWindow).__attention.points,
    ),
  ).toEqual([]);
  await page.clock.runFor(16_000);
  expect(
    await page.evaluate(
      () => (window as unknown as AttentionWindow).__attention.events,
    ),
  ).toEqual(["choices"]);
});

test("the validated Stop zone works by gaze after release and never becomes screenshot attention", async ({
  page,
}) => {
  await boot(page);
  const holdStop = async (frames: number) => {
    for (let frame = 0; frame < frames; frame++) {
      await page.evaluate(() =>
        (window as unknown as AttentionWindow).__attention.emit({
          x: 0.5,
          y: 0.1075,
          quality: 1,
          timestamp: performance.now() - 300,
          features: [],
          gesture: false,
        }),
      );
      await page.clock.runFor(333);
    }
  };
  await holdStop(8);
  expect(
    await page.evaluate(
      () => (window as unknown as AttentionWindow).__attention.events,
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as unknown as AttentionWindow).__attention.points,
    ),
  ).toEqual([]);
  await look(page, 0.25, 0.7);
  await holdStop(4);
  expect(
    await page.evaluate(
      () => (window as unknown as AttentionWindow).__attention.events,
    ),
  ).toEqual(["stop"]);
  expect(
    await page.evaluate(
      () => (window as unknown as AttentionWindow).__attention.points,
    ),
  ).toEqual([]);
  const bounds = await page
    .getByRole("button", { name: "Stop", exact: true })
    .boundingBox();
  expect(bounds!.x / 1440).toBeCloseTo(0.36, 3);
  expect(bounds!.y / 1000).toBeCloseTo(0.025, 3);
  expect(bounds!.width / 1440).toBeCloseTo(0.28, 3);
  expect(bounds!.height / 1000).toBeCloseTo(0.165, 3);
});

test("manual Stop latches before later gaze and timeout callbacks", async ({
  page,
}) => {
  const requests = await boot(page);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  for (let frame = 0; frame < 8; frame++) await look(page, 0.25, 0.7);
  await page.clock.runFor(16_000);
  expect(
    await page.evaluate(
      () => (window as unknown as AttentionWindow).__attention.events,
    ),
  ).toEqual(["stop"]);
  expect(
    await page.evaluate(
      () => (window as unknown as AttentionWindow).__attention.points,
    ),
  ).toEqual([]);
  expect(requests).toEqual([]);
});
