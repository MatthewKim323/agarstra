import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isFileServingAllowed, resolveConfig, type ResolvedConfig } from "vite";
import projectConfig from "../vite.config";

describe("development server private file boundary", () => {
  let config: ResolvedConfig;

  beforeAll(async () => {
    // Resolve the actual application policy without starting a server, loading
    // environment secrets, or reading any private file's contents.
    config = await resolveConfig(
      {
        configFile: false,
        envFile: false,
        root: resolve(import.meta.dirname, ".."),
        server: projectConfig.server,
      },
      "serve",
    );
  });

  const privatePaths = [
    ".nerve/personal-context.json",
    ".nerve/another-profile.json",
    ".nerve/nested/session.json",
    "packages/tool/.nerve/personal-context.json",
  ];

  it.each(privatePaths)(
    "denies the root-relative private path /%s after root resolution",
    (path) => {
      // Vite's static middleware resolves a root-relative request to its
      // absolute file before applying this same serving policy.
      expect(isFileServingAllowed(config, resolve(config.root, path))).toBe(
        false,
      );
    },
  );

  it.each(privatePaths)("denies the raw /@fs private path %s", (path) => {
    expect(
      isFileServingAllowed(config, `/@fs/${resolve(config.root, path)}`),
    ).toBe(false);
  });

  it.each(["?raw", "?import", "?v=123#fragment"])(
    "query syntax %s cannot bypass the private file restriction",
    (query) => {
      expect(
        isFileServingAllowed(
          config,
          `/@fs/${resolve(config.root, ".nerve/personal-context.json")}${query}`,
        ),
      ).toBe(false);
    },
  );

  it.each([
    ".env",
    ".env.local",
    "nested/.env.production",
    "credentials.pem",
    "nested/certificate.crt",
    ".git/config",
    "nested/.git/objects/secret",
  ])("preserves Vite's built-in protection for %s", (path) => {
    expect(isFileServingAllowed(config, resolve(config.root, path))).toBe(
      false,
    );
  });

  it.each([
    "index.html",
    "src/App.tsx",
    "src/components/CameraPanel.tsx",
    "public/vision/eye-gaze.onnx",
    ".nerve-public/example.json",
  ])("still allows the ordinary application file %s", (path) => {
    const file = resolve(config.root, path);
    expect(isFileServingAllowed(config, file)).toBe(true);
    expect(isFileServingAllowed(config, `/@fs/${file}`)).toBe(true);
  });

  it("keeps strict filesystem enforcement enabled", () => {
    expect(config.server.fs.strict).toBe(true);
  });
});
