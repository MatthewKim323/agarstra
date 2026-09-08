import { createApp } from "./app";

try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT")
    throw new Error(
      "The local .env file could not be loaded. Check its permissions and format.",
    );
}

const port = 4318;
const { app, session } = createApp();
const server = app.listen(port, "127.0.0.1", () => {
  console.info(
    `Nerve bridge ready at http://127.0.0.1:${port}. Browser starts only after you open a session.`,
  );
});
server.on("error", (error) => {
  console.error(
    "The local bridge could not start. Check whether port 4318 is already in use.",
    error instanceof Error ? error.name : "Error",
  );
  process.exitCode = 1;
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await session.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
