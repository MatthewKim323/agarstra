import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CameraTracker,
  CAMERA_PIPELINE_VERSION,
} from "../src/vision/CameraTracker";
import { createFaceDetector } from "../src/vision/runtime";
import { createNeuralGazeRuntime } from "../src/vision/neural-gaze";
import * as faceFeatures from "../src/vision/features";

const runtime = vi.hoisted(() => ({
  delegate: "CPU" as const,
  detector: { close: vi.fn(), detectForVideo: vi.fn() },
}));
const neural = vi.hoisted(() => ({
  close: vi.fn(),
  images: { mirror: vi.fn() },
  predict: vi.fn(),
}));
vi.mock("../src/vision/runtime", () => ({
  createFaceDetector: vi.fn(async () => runtime),
}));
vi.mock("../src/vision/neural-gaze", () => ({
  createNeuralGazeRuntime: vi.fn(async () => neural),
}));

class FrozenCanvas {
  pixels = "empty";
  context = {
    drawImage: vi.fn((source: { pixels: string }) => {
      this.pixels = source.pixels;
    }),
    clearRect: vi.fn(() => {
      this.pixels = "erased";
    }),
  };
  constructor(
    public width: number,
    public height: number,
  ) {
    canvases.push(this);
  }
  getContext() {
    return this.context;
  }
}
let canvases: FrozenCanvas[];
let frames: FrameRequestCallback[];
let trackers: CameraTracker[];
let now: number;

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function camera() {
  const settings = {
    deviceId: "actual-camera-device",
    width: 1280,
    height: 720,
  };
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn(),
    getSettings: vi.fn(() => settings),
    readyState: "live",
  };
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [track],
        getVideoTracks: () => [track],
      })),
    },
  });
  const video = {
    srcObject: null,
    play: vi.fn(async () => {}),
    readyState: 2,
    currentTime: 1,
    videoWidth: 640,
    videoHeight: 480,
    pixels: "capture A",
  } as unknown as HTMLVideoElement & { pixels: string };
  const tracker = new CameraTracker();
  trackers.push(tracker);
  return { video, tracker, track, settings, observe: vi.fn(), error: vi.fn() };
}

describe("camera frame coherence and truthful runtime diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canvases = [];
    frames = [];
    trackers = [];
    now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal("OffscreenCanvas", FrozenCanvas);
    vi.stubGlobal("document", { hidden: false });
    vi.stubGlobal("window", {
      innerWidth: 1440,
      innerHeight: 900,
      devicePixelRatio: 2,
      visualViewport: { scale: 1.25 },
    });
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.mocked(createFaceDetector).mockResolvedValue(
      runtime as unknown as Awaited<ReturnType<typeof createFaceDetector>>,
    );
    vi.mocked(createNeuralGazeRuntime).mockResolvedValue(
      neural as unknown as Awaited<ReturnType<typeof createNeuralGazeRuntime>>,
    );
    neural.images.mirror.mockImplementation((source) => ({
      pixels: source.pixels,
    }));
    neural.predict.mockResolvedValue({
      raw: { x: 0.5, y: 0.5 },
      keypoints: Array(8).fill(0),
      inferenceMs: 20,
    });
    runtime.detector.detectForVideo.mockReturnValue({
      faceLandmarks: [[]],
      faceBlendshapes: [],
    });
    vi.spyOn(faceFeatures, "extractFaceFeatures").mockReturnValue({
      features: Array(8).fill(0),
      quality: 1,
      reason: "Visible",
      gestures: { jawOpen: 0, browInnerUp: 0, mouthSmile: 0 },
    });
  });
  afterEach(() => {
    trackers.forEach((tracker) => tracker.stop());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("pairs landmarks and eye pixels from one frozen capture even if live video advances during detection", async () => {
    const { tracker, video, observe, error } = camera();
    runtime.detector.detectForVideo.mockImplementation(
      (source: { pixels: string }) => {
        expect(source.pixels).toBe("capture A");
        video.pixels = "capture B";
        return { faceLandmarks: [[]], faceBlendshapes: [] };
      },
    );
    neural.predict.mockImplementation(async (source: { pixels: string }) => {
      expect(source).not.toBe(video);
      expect(source.pixels).toBe("capture A");
      return {
        raw: { x: 0.5, y: 0.5 },
        keypoints: Array(8).fill(0),
        inferenceMs: 20,
      };
    });
    await tracker.start(video, observe, error);
    frames.at(-1)!(now);
    await flush();
    expect(neural.predict).toHaveBeenCalledOnce();
    expect(neural.predict.mock.calls[0][0]).toBe(
      neural.images.mirror.mock.calls[0][0],
    );
    expect(canvases[0].context.drawImage).toHaveBeenCalledExactlyOnceWith(
      video,
      0,
      0,
      640,
      480,
    );
    expect(observe.mock.calls.at(-1)?.[0].quality).toBe(1);
    expect(error).not.toHaveBeenCalled();
    tracker.stop();
    expect(canvases[0].pixels).toBe("erased");
    expect([canvases[0].width, canvases[0].height]).toEqual([1, 1]);
  });

  it("does not overwrite a pending capture and erases it when stopped before inference returns", async () => {
    const { tracker, video, observe, error } = camera();
    let finish!: (value: null) => void;
    neural.predict.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await tracker.start(video, observe, error);
    frames.at(-1)!(now);
    await flush();
    video.pixels = "later frame";
    video.currentTime = 2;
    now += 100;
    frames.at(-1)!(now);
    expect(canvases[0].pixels).toBe("capture A");
    expect(canvases[0].context.drawImage).toHaveBeenCalledOnce();
    tracker.stop();
    const notificationsAtStop = observe.mock.calls.length;
    expect(canvases[0].pixels).toBe("erased");
    finish(null);
    await flush();
    expect(observe).toHaveBeenCalledTimes(notificationsAtStop);
    expect(error).not.toHaveBeenCalled();
  });

  it("records end-to-end latency and model timing before rejecting a stale result", async () => {
    const { tracker, video, observe, error } = camera();
    runtime.detector.detectForVideo.mockImplementation(() => {
      now += 200;
      return { faceLandmarks: [[]], faceBlendshapes: [] };
    });
    neural.predict.mockImplementation(async () => {
      now += 320;
      return {
        raw: { x: 0.5, y: 0.5 },
        keypoints: Array(8).fill(0),
        inferenceMs: 320,
      };
    });
    await tracker.start(video, observe, error);
    frames.at(-1)!(1000);
    await flush();
    expect(tracker.getDiagnostics()).toMatchObject({
      running: true,
      frames: 1,
      totalResults: 1,
      staleResults: 1,
      lastCaptureLatencyMs: 520,
      inferenceMs: 320,
    });
    expect(observe.mock.calls.at(-1)?.[0]).toMatchObject({
      quality: 0,
      features: [],
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("releases the captured pixel buffer even when the canvas context cannot clear", async () => {
    const { tracker, video, observe, error, track } = camera();
    await tracker.start(video, observe, error);
    frames.at(-1)!(now);
    await flush();
    canvases[0].context.clearRect.mockImplementationOnce(() => {
      throw new Error("Context was lost.");
    });
    expect(() => tracker.stop()).not.toThrow();
    expect([canvases[0].width, canvases[0].height]).toEqual([1, 1]);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(neural.close).toHaveBeenCalledOnce();
    expect(tracker.getDiagnostics().running).toBe(false);
  });

  it("keeps the existing 450 ms tracker boundary and exposes the separate 350 ms consumer limitation", async () => {
    const { tracker, video, observe, error } = camera();
    neural.predict.mockImplementation(async () => {
      now += 400;
      return {
        raw: { x: 0.5, y: 0.5 },
        keypoints: Array(8).fill(0),
        inferenceMs: 400,
      };
    });
    await tracker.start(video, observe, error);
    frames.at(-1)!(1000);
    await flush();
    expect(tracker.getDiagnostics()).toMatchObject({
      totalResults: 1,
      staleResults: 0,
      lastCaptureLatencyMs: 400,
      inferenceMs: 400,
    });
    expect(observe.mock.calls.at(-1)?.[0]).toMatchObject({
      quality: 1,
      timestamp: 1000,
    });
  });

  it("records worker latency without changing its immutable bitmap path", async () => {
    let worker!: ReadyWorker;
    class ReadyWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: unknown = null;
      terminate = vi.fn();
      constructor() {
        worker = this;
      }
      postMessage = vi.fn((message: { type: string; timestamp?: number }) => {
        if (message.type === "init") {
          queueMicrotask(() =>
            this.onmessage?.({
              data: { type: "ready", delegate: "CPU" },
            } as MessageEvent),
          );
        } else {
          now += 600;
          this.onmessage?.({
            data: {
              type: "result",
              timestamp: message.timestamp,
              result: { faceLandmarks: [], faceBlendshapes: [] },
              neural: {
                raw: { x: 0.5, y: 0.5 },
                keypoints: Array(8).fill(0),
                inferenceMs: 490,
              },
            },
          } as MessageEvent);
        }
      });
    }
    const bitmap = { close: vi.fn() };
    vi.stubGlobal("Worker", ReadyWorker);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => bitmap),
    );
    const { tracker, video, observe, error } = camera();
    await tracker.start(video, observe, error);
    frames.at(-1)!(1000);
    await flush();
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      { type: "frame", bitmap, timestamp: 1000 },
      [bitmap],
    );
    expect(canvases).toHaveLength(0);
    expect(tracker.getDiagnostics()).toMatchObject({
      totalResults: 1,
      staleResults: 1,
      lastCaptureLatencyMs: 600,
      inferenceMs: 490,
    });
    expect(observe.mock.calls.at(-1)?.[0].quality).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });

  it("returns actual device and capture settings only after explicit camera start", async () => {
    const { tracker, video, observe, error, track } = camera();
    expect(tracker.getEnvironment()).toBeNull();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    await tracker.start(video, observe, error);
    expect(tracker.getEnvironment()).toEqual({
      deviceId: "actual-camera-device",
      captureWidth: 640,
      captureHeight: 480,
      viewportWidth: 1440,
      viewportHeight: 900,
      devicePixelRatio: 2,
      viewportScale: 1.25,
      pipelineVersion: CAMERA_PIPELINE_VERSION,
      featureCount: 18,
    });
    Object.assign(video, { videoWidth: 0, videoHeight: 0 });
    expect(tracker.getEnvironment()).toMatchObject({
      captureWidth: 1280,
      captureHeight: 720,
    });
    track.getSettings.mockImplementationOnce(() => {
      throw new Error("unavailable settings");
    });
    expect(tracker.getEnvironment()).toBeNull();
    Object.assign(video, { videoWidth: 640, videoHeight: 480 });
    track.getSettings.mockImplementationOnce(() => {
      throw new Error("unavailable settings");
    });
    expect(tracker.getEnvironment()?.deviceId).toBeNull();
    tracker.stop();
    expect(tracker.getEnvironment()).toBeNull();
    expect(tracker.getDiagnostics()).toMatchObject({
      lastCaptureLatencyMs: null,
      totalResults: 0,
      staleResults: 0,
    });
  });
});
