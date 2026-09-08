import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { createApp } from "../../server/app";

test("built app loads both local vision models and stops a synthetic camera", async () => {
  test.setTimeout(90_000);
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test server address.");
  const origin = `http://127.0.0.1:${address.port}`;
  const { app, session } = createApp({
    production: true,
    allowedPorts: [address.port],
    distPath: resolve("dist"),
  });
  server.on("request", app);
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
    });
    await context.addInitScript(() => {
      const streams: MediaStream[] = [];
      (
        window as Window & { __syntheticStreams?: MediaStream[] }
      ).__syntheticStreams = streams;
      const native = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await native(constraints);
        streams.push(stream);
        return stream;
      };
    });
    const page = await context.newPage();
    const requests: string[] = [],
      external: string[] = [],
      errors: string[] = [];
    context.on("request", (request) => {
      const url = request.url();
      if (url.includes("/vision/")) requests.push(url);
      if (url.startsWith("http") && new URL(url).origin !== origin)
        external.push(url);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole("button", { name: "Camera", exact: true }).click();
    await page
      .getByRole("button", { name: "Enable camera", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Calibrate gaze", exact: true }),
    ).toBeEnabled({ timeout: 60_000 });
    expect(requests.some((url) => url.endsWith("face_landmarker.task"))).toBe(
      true,
    );
    expect(requests.some((url) => url.endsWith("peekr.onnx"))).toBe(true);
    expect(
      requests.some(
        (url) => url.includes("/vision/onnx/") && url.endsWith(".wasm"),
      ),
    ).toBe(true);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
    await page
      .getByRole("button", { name: "Stop camera", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const streams =
            (window as Window & { __syntheticStreams?: MediaStream[] })
              .__syntheticStreams ?? [];
          return (
            streams.length === 1 &&
            streams.every((stream) =>
              stream.getTracks().every((track) => track.readyState === "ended"),
            )
          );
        }),
      )
      .toBe(true);
    await context.close();
  } finally {
    await browser.close();
    await session.reset();
    await new Promise<void>((resolveClosed, reject) =>
      server.close((error) => (error ? reject(error) : resolveClosed())),
    );
  }
});
