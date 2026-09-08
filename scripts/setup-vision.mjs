/**
 * Download only public Google model assets; never requests camera access.
 * MediaPipe code is Apache-2.0. Model source/model card and license details:
 * https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/index#models
 * https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
 * Local asset serving avoids third-party CDN requests during camera use.
 */
import {
  cp,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "public", "vision");
const modelPath = join(target, "face_landmarker.task");
const source =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
// Version-1 asset retrieved from the official HTTPS URL on 2026-09-08.
// This reproducibility pin detects truncation/replacement, not a publisher signature.
const expectedSha256 =
  "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";
const temporary = `${modelPath}.download-${process.pid}`;

try {
  await mkdir(target, { recursive: true });
  await cp(
    join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm"),
    join(target, "wasm"),
    { recursive: true },
  );
  const present = await readFile(modelPath)
    .then(
      (bytes) =>
        createHash("sha256").update(bytes).digest("hex") === expectedSha256,
    )
    .catch(() => false);
  if (present) {
    console.log(
      "Local vision assets are ready. Existing Face Landmarker model retained.",
    );
  } else {
    console.log(
      "Downloading the official Google Face Landmarker model for local inference...",
    );
    const response = await fetch(source, {
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok)
      throw new Error(`Model download returned HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1000000 || bytes.length > 100000000)
      throw new Error("Unexpected model download size.");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expectedSha256)
      throw new Error(
        "Model integrity check failed. The pinned official asset may have changed; no new model was installed.",
      );
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, modelPath);
    await writeFile(
      join(target, "model-source.json"),
      JSON.stringify(
        {
          source,
          downloadedAt: new Date().toISOString(),
          bytes: bytes.length,
          sha256,
          note: "Hash matches the application reproducibility pin; it is not a publisher-signed integrity guarantee.",
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      `Local vision assets ready (${(bytes.length / 1024 / 1024).toFixed(1)} MiB model). Webcam remains off until explicitly started.`,
    );
  }
} catch (error) {
  await unlink(temporary).catch(() => {});
  console.error(
    `Vision setup unavailable: ${error instanceof Error ? error.message : error}`,
  );
  console.error(
    "Pointer and switch modes still work. Re-run npm run setup when online to enable the optional webcam.",
  );
  process.exitCode = 1;
}
