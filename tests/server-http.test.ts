import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { createApp } from "../server/app";

describe("localhost HTTP security boundary", () => {
  let server: Server, base: string;
  beforeAll(async () => {
    const created = createApp();
    server = await new Promise<Server>((resolve) => {
      const instance = created.app.listen(0, "127.0.0.1", () =>
        resolve(instance),
      );
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No listen address");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const request = (path: string, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        base + path,
        {
          method: init.method ?? "GET",
          headers: {
            Host: "127.0.0.1:4318",
            ...(init.headers as Record<string, string>),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const headers = new Headers();
            Object.entries(res.headers).forEach(([key, value]) => {
              if (value !== undefined)
                headers.set(
                  key,
                  Array.isArray(value) ? value.join(", ") : value,
                );
            });
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers,
              }),
            );
          });
        },
      );
      req.on("error", reject);
      req.end(init.body as string | undefined);
    });

  it("returns safe idle state without launching a browser", async () => {
    const result = await request("/api/state");
    expect(result.status).toBe(200);
    const state = await result.json();
    expect(state.screenshot).toBeNull();
    expect(JSON.stringify(state)).not.toContain("sk-");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.has("access-control-allow-origin")).toBe(false);
  });
  it.each(["evil.example", "127.0.0.1.evil.example:4318", "localhost:9999"])(
    "blocks invalid Host %s",
    async (host) => {
      expect(
        (await request("/api/state", { headers: { Host: host } })).status,
      ).toBe(403);
    },
  );
  it.each(["https://evil.example", "null", "http://127.0.0.1:9999"])(
    "blocks foreign Origin %s",
    async (origin) => {
      expect(
        (
          await request("/api/stop", {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
    },
  );
  it("blocks cross-site fetch even when other headers look local", async () => {
    expect(
      (
        await request("/api/state", {
          headers: { "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
    ).toBe(403);
  });
  it("blocks simple-request CSRF content types", async () => {
    expect(
      (
        await request("/api/stop", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
  });
  it("accepts same-origin JSON, rejects unknown fields and malformed input", async () => {
    expect(
      (
        await request("/api/stop", {
          method: "POST",
          headers: {
            Origin: "http://127.0.0.1:4317",
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(200);
    for (const body of ["{", '{"goal":"","secret":"secret-fixture-938"}']) {
      const result = await request("/api/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(result.status).toBe(400);
      expect(await result.text()).not.toContain("secret-fixture-938");
    }
  });
  it("rejects screenshots or webcam frames in request bodies", async () => {
    const result = await request("/api/candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        point: { x: 0.5, y: 0.5 },
        webcam: "data:image/png;base64,private",
      }),
    });
    expect(result.status).toBe(400);
  });
  it("only accepts normalized candidate points", async () => {
    const result = await request("/api/candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ point: { x: 640, y: 400 } }),
    });
    expect(result.status).toBe(400);
  });
  it("serves the fully local practice app with restrictive CSP", async () => {
    const result = await request("/lab");
    expect(result.status).toBe(200);
    expect(result.headers.get("content-security-policy")).toContain(
      "connect-src 'none'",
    );
    expect(await result.text()).toContain("fieldnotes");
    const script = await request("/lab/app.js");
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("nerve-practice-v1");
  });
});
