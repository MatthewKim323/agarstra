import type { FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import type { InferenceSession, Tensor } from "onnxruntime-web/wasm";
import { EyeImageProcessor, EYE_IMAGE_SIZE } from "./eye-images";

export type NeuralGaze = {
  raw: { x: number; y: number };
  keypoints: number[];
  inferenceMs: number;
};
export interface NeuralGazeRuntime {
  images: EyeImageProcessor;
  predict(
    source: CanvasImageSource,
    width: number,
    height: number,
    result: FaceLandmarkerResult,
  ): Promise<NeuralGaze | null>;
  close(): void;
}

/** Actual pretrained Peekr CNN. One inference at a time, WASM and weights served locally. */
export async function createNeuralGazeRuntime(): Promise<NeuralGazeRuntime> {
  const ort = await import("onnxruntime-web/wasm");
  // Keep ORT's bundled JS loader. Vite intentionally rejects JS imports from public/.
  // Override only the binary URL so both dev and production use local WASM.
  ort.env.wasm.wasmPaths = { wasm: "/vision/onnx/ort-wasm-simd-threaded.wasm" };
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  const session = await ort.InferenceSession.create("/vision/peekr.onnx", {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  if (
    !["input1", "input2", "kps"].every((name) =>
      session.inputNames.includes(name),
    ) ||
    !session.outputNames.includes("output")
  ) {
    await session.release();
    throw new Error(
      "The local gaze model has incompatible inputs. Re-run npm run setup.",
    );
  }
  let images: EyeImageProcessor;
  try {
    images = new EyeImageProcessor();
  } catch (error) {
    await session.release();
    throw error;
  }
  let closed = false;
  let inFlight = false;
  let released = false;
  const release = () => {
    if (released || inFlight) return;
    released = true;
    images.clear();
    void session.release().catch(() => {});
  };
  return {
    images,
    async predict(source, width, height, result) {
      if (closed || inFlight || result.faceLandmarks.length !== 1) return null;
      const crops = images.tensors(
        source,
        width,
        height,
        result.faceLandmarks[0],
      );
      if (!crops) return null;
      inFlight = true;
      const start = performance.now();
      const dims = [1, 3, EYE_IMAGE_SIZE, EYE_IMAGE_SIZE];
      const feeds: Record<string, Tensor> = {};
      let output: InferenceSession.OnnxValueMapType | null = null;
      try {
        feeds.input1 = new ort.Tensor("float32", crops.left, dims);
        feeds.input2 = new ort.Tensor("float32", crops.right, dims);
        feeds.kps = new ort.Tensor(
          "float32",
          new Float32Array(crops.keypoints),
          [1, 8],
        );
        output = await session.run(feeds);
        if (closed) return null;
        const values = output.output?.data;
        const x = Number(values?.[0]),
          y = Number(values?.[1]);
        if (
          !values ||
          values.length !== 2 ||
          !Number.isFinite(x) ||
          !Number.isFinite(y)
        )
          throw new Error("The local gaze model returned invalid coordinates.");
        // These are learned features, not calibrated viewport coordinates. Never clamp here.
        return {
          raw: { x, y },
          keypoints: crops.keypoints,
          inferenceMs: performance.now() - start,
        };
      } finally {
        Object.values(feeds).forEach((tensor) => tensor.dispose());
        if (output) Object.values(output).forEach((tensor) => tensor.dispose());
        inFlight = false;
        if (closed) release();
      }
    },
    close() {
      closed = true;
      release();
    },
  };
}
