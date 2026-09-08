import { createFaceDetector, type DetectorRuntime } from "./runtime";

let runtime: DetectorRuntime | null = null;

self.onmessage = async (
  event: MessageEvent<{
    type: "init" | "frame";
    bitmap?: ImageBitmap;
    timestamp?: number;
  }>,
) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      runtime = await createFaceDetector();
      self.postMessage({ type: "ready", delegate: runtime.delegate });
      return;
    }
    if (!runtime || !message.bitmap || message.timestamp === undefined) return;
    const result = runtime.detector.detectForVideo(
      message.bitmap,
      message.timestamp,
    );
    self.postMessage({ type: "result", result, timestamp: message.timestamp });
  } catch (error) {
    self.postMessage({
      type: "error",
      message:
        error instanceof Error ? error.message : "Face detection failed.",
    });
  } finally {
    message.bitmap?.close();
  }
};
