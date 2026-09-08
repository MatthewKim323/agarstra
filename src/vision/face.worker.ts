import { createFaceDetector, type DetectorRuntime } from "./runtime";
import { createNeuralGazeRuntime, type NeuralGazeRuntime } from "./neural-gaze";

let runtime: DetectorRuntime | null = null;
let neural: NeuralGazeRuntime | null = null;
let busy = false;

self.onmessage = async (
  event: MessageEvent<{
    type: "init" | "frame";
    bitmap?: ImageBitmap;
    timestamp?: number;
  }>,
) => {
  const message = event.data;
  let ownsBusy = false;
  try {
    if (message.type === "init") {
      if (busy || runtime || neural) return;
      busy = ownsBusy = true;
      runtime = await createFaceDetector();
      neural = await createNeuralGazeRuntime();
      self.postMessage({ type: "ready", delegate: runtime.delegate });
      return;
    }
    if (
      !runtime ||
      !neural ||
      busy ||
      !message.bitmap ||
      message.timestamp === undefined
    )
      return;
    busy = ownsBusy = true;
    const { width, height } = message.bitmap;
    // Match the published Peekr selfieMode graph: mirror BEFORE landmark inference.
    const mirrored = neural.images.mirror(message.bitmap, width, height);
    const result = runtime.detector.detectForVideo(mirrored, message.timestamp);
    const gaze = await neural.predict(message.bitmap, width, height, result);
    self.postMessage({
      type: "result",
      result,
      neural: gaze,
      timestamp: message.timestamp,
    });
  } catch (error) {
    if (message.type === "init") {
      const face = runtime;
      const gaze = neural;
      runtime = null;
      neural = null;
      try {
        face?.detector.close();
      } catch {
        /* Continue releasing owned resources. */
      }
      try {
        gaze?.close();
      } catch {
        /* Preserve the original initialization error. */
      }
    }
    self.postMessage({
      type: "error",
      message:
        error instanceof Error ? error.message : "Face detection failed.",
    });
  } finally {
    if (ownsBusy) busy = false;
    message.bitmap?.close();
  }
};
