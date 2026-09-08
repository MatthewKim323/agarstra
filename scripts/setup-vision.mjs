/**
 * Download pinned public Google and MIT Peekr model assets; never requests camera access.
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
const neuralPath = join(target, "peekr.onnx");
const neuralTemporary = `${neuralPath}.download-${process.pid}`;
const neuralSource =
  "https://raw.githubusercontent.com/HugoFara/peekr/d3ea61e4a34ce9463d83979c286ba9a8712b514a/public/peekr.onnx";
const neuralSha256 =
  "9abc6c98ee02ee518da98777d1cd879ff9bbaf71491ed2c803a608e9740ce7fb";

try {
  await mkdir(target, { recursive: true });
  await cp(
    join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm"),
    join(target, "wasm"),
    { recursive: true },
  );
  const onnxTarget = join(target, "onnx");
  await mkdir(onnxTarget, { recursive: true });
  for (const file of [
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.mjs",
  ]) {
    await cp(
      join(root, "node_modules", "onnxruntime-web", "dist", file),
      join(onnxTarget, file),
    );
  }
  await cp(
    join(root, "THIRD_PARTY_NOTICES.md"),
    join(target, "THIRD_PARTY_NOTICES.md"),
  );
  const neuralPresent = await readFile(neuralPath)
    .then(
      (bytes) =>
        createHash("sha256").update(bytes).digest("hex") === neuralSha256,
    )
    .catch(() => false);
  if (!neuralPresent) {
    console.log(
      "Downloading the pinned MIT Peekr pretrained gaze model for local inference...",
    );
    const response = await fetch(neuralSource, {
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok)
      throw new Error(`Gaze model download returned HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      bytes.length !== 579176 ||
      createHash("sha256").update(bytes).digest("hex") !== neuralSha256
    )
      throw new Error(
        "Gaze model integrity check failed; no new gaze model was installed.",
      );
    await writeFile(neuralTemporary, bytes, { flag: "wx" });
    await rename(neuralTemporary, neuralPath);
  }
  await writeFile(
    join(target, "gaze-model-source.json"),
    JSON.stringify(
      {
        source: neuralSource,
        sha256: neuralSha256,
        bytes: 579176,
        license: "MIT",
        runtime: "onnxruntime-web@1.29.0",
        preprocessing: "mirrored detection, original BGR eye crops, 128x128",
        note: "Model output requires independent personal calibration. Upstream accuracy is not Nerve validation.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Local Peekr gaze model and ONNX WASM assets are ready.");
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
  await unlink(neuralTemporary).catch(() => {});
  console.error(
    `Vision setup unavailable: ${error instanceof Error ? error.message : error}`,
  );
  console.error(
    "Pointer and switch modes still work. Re-run npm run setup when online to enable the optional webcam.",
  );
  process.exitCode = 1;
}
