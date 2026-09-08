import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [major, minor] = process.versions.node.split(".").map(Number);
if (!(major > 22 || (major === 22 && minor >= 12))) {
  console.error(
    `Nerve requires Node.js 22.12 or newer. Found ${process.version}.`,
  );
  process.exitCode = 1;
} else {
  await start();
}

async function portOccupied() {
  return new Promise((resolveResult) => {
    const socket = createConnection({ host: "127.0.0.1", port: 4318 });
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolveResult(value);
    };
    socket.setTimeout(750);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function start() {
  if (await portOccupied()) {
    let nerve = false;
    try {
      const response = await fetch("http://127.0.0.1:4318/api/health", {
        signal: AbortSignal.timeout(1500),
      });
      const health = await response.json();
      nerve =
        response.ok &&
        health.ok === true &&
        health.model === "gpt-6-astra" &&
        health.isolation === "single-user localhost" &&
        health.webcamUpload === false;
    } catch {
      /* An unrelated service may not have a JSON health endpoint. */
    }
    console.error(
      nerve
        ? "Nerve is already running on port 4318. Open its existing interface; no process was started or stopped."
        : "Port 4318 is occupied. Nerve will not stop another process. Close that service yourself before starting Nerve.",
    );
    process.exitCode = 1;
    return;
  }
  if (!existsSync(resolve(root, "dist/index.html"))) {
    console.error(
      "The production interface has not been built. Run npm run build, then npm start.",
    );
    process.exitCode = 1;
    return;
  }
  try {
    process.loadEnvFile(resolve(root, ".env"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(
        "The local .env file could not be loaded. Check its permissions and format.",
      );
      process.exitCode = 1;
      return;
    }
  }
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve(root, "server/index.ts")],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "production" },
    },
  );
  let terminated = false;
  let killTimer;
  const stop = (signal) => {
    if (terminated) return;
    terminated = true;
    child.kill(signal);
    killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    killTimer.unref();
  };
  const onInterrupt = () => stop("SIGINT");
  const onTerminate = () => stop("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  process.once("SIGHUP", onTerminate);
  child.once("error", () => {
    console.error(
      "Nerve could not launch its local server. Check Node.js and run npm ci again.",
    );
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    clearTimeout(killTimer);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    process.off("SIGHUP", onTerminate);
    process.exitCode =
      code ?? (signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1);
  });
}
