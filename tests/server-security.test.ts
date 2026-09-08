import { describe, expect, it } from "vitest";
import {
  createNetworkPolicy,
  isAllowedRequest,
  isPublicAddress,
} from "../server/security";
import { parseActions, normalizeKeys } from "../server/actions";

describe("network isolation", () => {
  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.2",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2001::1",
    "2001:0000::1",
    "2002:7f00:1::1",
    "3fff::1",
  ])("blocks non-global destination %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])("accepts global destination %s", (address) =>
    expect(isPublicAddress(address)).toBe(true),
  );
  it("only allows the lab path on its one local origin", async () => {
    const policy = await createNetworkPolicy(
      "http://127.0.0.1:4318/lab",
      "http://127.0.0.1:4318",
    );
    expect(isAllowedRequest("http://127.0.0.1:4318/lab/app.js", policy)).toBe(
      true,
    );
    expect(isAllowedRequest("http://127.0.0.1:4318/api/state", policy)).toBe(
      false,
    );
    expect(
      isAllowedRequest("http://127.0.0.1:4318/lab/../api/state", policy),
    ).toBe(false);
    expect(isAllowedRequest("http://localhost:4318/lab", policy)).toBe(false);
    expect(isAllowedRequest("file:///etc/passwd", policy)).toBe(false);
  });
  it.each([
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com:8443",
    "https://localhost",
    "https://intranet.local",
    "https://127.1",
    "https://2130706433",
    "https://0x7f000001",
    "https://[::ffff:127.0.0.1]",
  ])("rejects unsafe session URL %s", async (url) => {
    await expect(
      createNetworkPolicy(url, "http://127.0.0.1:4318"),
    ).rejects.toThrow();
  });
  it("rejects mixed public and private DNS answers", async () => {
    await expect(
      createNetworkPolicy(
        "https://example.com",
        "http://127.0.0.1:4318",
        async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      ),
    ).rejects.toThrow("reserved");
  });
  it("pins an approved address and blocks all other origins", async () => {
    const policy = await createNetworkPolicy(
      "https://example.com/path",
      "http://127.0.0.1:4318",
      async () => [{ address: "93.184.216.34", family: 4 }],
    );
    expect(policy.pinnedAddress).toBe("93.184.216.34");
    expect(isAllowedRequest("https://example.com/assets/a.js", policy)).toBe(
      true,
    );
    expect(
      isAllowedRequest("https://sub.example.com/assets/a.js", policy),
    ).toBe(false);
    expect(isAllowedRequest("https://example.com.evil.com", policy)).toBe(
      false,
    );
    expect(isAllowedRequest("https://user:pass@example.com", policy)).toBe(
      false,
    );
    expect(isAllowedRequest("http://example.com", policy)).toBe(false);
    expect(isAllowedRequest("javascript:alert(1)", policy)).toBe(false);
  });
});

describe("computer action contract", () => {
  it("accepts all supported, bounded primitives", () => {
    expect(
      parseActions([
        { type: "click", x: 12, y: 34 },
        { type: "keypress", keys: ["CTRL", "a"] },
        { type: "type", text: "hi" },
        { type: "screenshot" },
      ]),
    ).toHaveLength(4);
    expect(normalizeKeys(["CMD", "A"])).toEqual(["Meta", "A"]);
  });
  it("normalizes empty native pointer modifiers without weakening strict field checks", () => {
    expect(parseActions([{ type: "click", x: 12, y: 34, keys: null }])).toEqual(
      [{ type: "click", x: 12, y: 34 }],
    );
    expect(parseActions([{ type: "click", x: 12, y: 34, keys: [] }])).toEqual([
      { type: "click", x: 12, y: 34 },
    ]);
    expect(() =>
      parseActions([{ type: "click", x: 12, y: 34, keys: ["Meta"] }]),
    ).toThrow();
    expect(() =>
      parseActions([{ type: "click", x: 12, y: 34, execute: null }]),
    ).toThrow();
  });
  it.each(
    [
      [{ type: "click", x: 1280, y: 0 }],
      [{ type: "click", x: 0, y: -1 }],
      [{ type: "click", x: 1, y: 1, selector: "#delete" }],
      [{ type: "click", x: 1, y: 1, button: "right" }],
      [{ type: "type", text: "x".repeat(6001) }],
      [{ type: "exec", code: "fetch(secret)" }],
      [{ type: "keypress", keys: ["F12"] }],
      [{ type: "keypress", keys: ["CTRL", "L"] }],
      [{ type: "keypress", keys: ["Meta", "V"] }],
      [{ type: "drag", path: [{ x: 1, y: 1 }] }],
      [{ type: "keypress", keys: ["Alt", "D"] }],
      [{ type: "keypress", keys: ["Control", "Shift", "A"] }],
      [{ type: "scroll", x: 0, y: 0, scroll_x: 0, scroll_y: Infinity }],
      [],
    ].map((actions) => ({ actions })),
  )("rejects unsupported or unsafe actions $actions", ({ actions }) =>
    expect(() => parseActions(actions)).toThrow(),
  );
});
