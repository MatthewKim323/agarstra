import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraTracker } from "../src/vision/CameraTracker";
import { createFaceDetector } from "../src/vision/runtime";
import { createNeuralGazeRuntime } from "../src/vision/neural-gaze";
import * as calibration from "../src/vision/calibration";
import * as faceFeatures from "../src/vision/features";

const mockRuntime = vi.hoisted(() => ({
  detector: { close: vi.fn(), detectForVideo: vi.fn() },
  delegate: "CPU" as const,
}));
vi.mock("../src/vision/runtime", () => ({
  createFaceDetector: vi.fn(async () => mockRuntime),
}));
const mockNeural = vi.hoisted(() => ({
  close: vi.fn(),
  predict: vi.fn(async () => null),
  images: { mirror: vi.fn() },
}));
vi.mock("../src/vision/neural-gaze", () => ({
  createNeuralGazeRuntime: vi.fn(async () => mockNeural),
}));

describe("camera consent and lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          return { drawImage: vi.fn(), clearRect: vi.fn() };
        }
      },
    );
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("document", { hidden: false });
    vi.clearAllMocks();
    vi.mocked(createFaceDetector).mockResolvedValue(
      mockRuntime as unknown as Awaited<ReturnType<typeof createFaceDetector>>,
    );
    vi.mocked(createNeuralGazeRuntime).mockResolvedValue(
      mockNeural as unknown as Awaited<
        ReturnType<typeof createNeuralGazeRuntime>
      >,
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not request the camera merely by constructing a tracker", () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const tracker = new CameraTracker();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(tracker.getDiagnostics().running).toBe(false);
  });
  it("reports permission denial without leaving active resources", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      },
    });
    const tracker = new CameraTracker();
    const onError = vi.fn();
    const video = {
      srcObject: null,
      play: vi.fn(),
    } as unknown as HTMLVideoElement;
    await expect(tracker.start(video, vi.fn(), onError)).rejects.toThrow(
      /permission was denied/,
    );
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("permission was denied"),
    );
    expect(tracker.getDiagnostics().running).toBe(false);
    expect(video.srcObject).toBe(null);
  });
  it("requests no audio and releases tracks, detector and video on stop", async () => {
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const tracker = new CameraTracker();
    const video = {
      srcObject: null,
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLVideoElement;
    await tracker.start(video, vi.fn(), vi.fn());
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: false }),
    );
    expect(tracker.getDiagnostics().running).toBe(true);
    tracker.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(mockRuntime.detector.close).toHaveBeenCalledOnce();
    expect(mockNeural.close).toHaveBeenCalledOnce();
    expect(video.srcObject).toBe(null);
  });
  it("stops a late permission response after cancellation", async () => {
    let resolve!: (stream: unknown) => void;
    const getUserMedia = vi.fn().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const tracker = new CameraTracker();
    const video = {
      srcObject: null,
      play: vi.fn(),
    } as unknown as HTMLVideoElement;
    const pending = tracker.start(video, vi.fn(), vi.fn());
    tracker.stop();
    const stop = vi.fn();
    resolve({ getTracks: () => [{ stop }] });
    await pending;
    expect(stop).toHaveBeenCalledOnce();
    expect(video.play).not.toHaveBeenCalled();
    expect(tracker.getDiagnostics().running).toBe(false);
  });
  it("cancels and terminates a worker while its model is still initializing", async () => {
    const instances: { terminate: ReturnType<typeof vi.fn> }[] = [];
    class PendingWorker {
      onmessage: unknown = null;
      onerror: unknown = null;
      postMessage = vi.fn();
      terminate = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("Worker", PendingWorker);
    vi.stubGlobal("createImageBitmap", vi.fn());
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [track],
          getVideoTracks: () => [track],
        }),
      },
    });
    const tracker = new CameraTracker();
    const video = {
      srcObject: null,
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLVideoElement;
    const pending = tracker.start(video, vi.fn(), vi.fn());
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    tracker.stop();
    await pending;
    expect(instances[0].terminate).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(tracker.getDiagnostics().running).toBe(false);
  });

  function camera() {
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [track],
          getVideoTracks: () => [track],
        }),
      },
    });
    const video = {
      srcObject: null,
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLVideoElement;
    return { track, video, tracker: new CameraTracker(), onError: vi.fn() };
  }
  async function flush() {
    for (let count = 0; count < 12; count++) await Promise.resolve();
  }

  it("finishes cancellation immediately while the fallback face model is loading", async () => {
    let resolve!: (
      runtime: Awaited<ReturnType<typeof createFaceDetector>>,
    ) => void;
    vi.mocked(createFaceDetector).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { tracker, video, track, onError } = camera();
    let finished = false;
    const pending = tracker.start(video, vi.fn(), onError).then(() => {
      finished = true;
    });
    await flush();
    expect(createFaceDetector).toHaveBeenCalledOnce();
    tracker.stop();
    await flush();
    const finishedBeforeLateModel = finished;
    resolve(
      mockRuntime as unknown as Awaited<ReturnType<typeof createFaceDetector>>,
    );
    await pending;
    await flush();
    expect(finishedBeforeLateModel).toBe(true);
    expect(mockRuntime.detector.close).toHaveBeenCalledOnce();
    expect(createNeuralGazeRuntime).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("closes the face model immediately and the neural model when it arrives after Stop", async () => {
    let resolve!: (
      runtime: Awaited<ReturnType<typeof createNeuralGazeRuntime>>,
    ) => void;
    vi.mocked(createNeuralGazeRuntime).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { tracker, video, track, onError } = camera();
    let finished = false;
    const pending = tracker.start(video, vi.fn(), onError).then(() => {
      finished = true;
    });
    await flush();
    expect(createNeuralGazeRuntime).toHaveBeenCalledOnce();
    tracker.stop();
    await flush();
    const finishedBeforeLateModel = finished;
    const faceClosedAtStop = mockRuntime.detector.close.mock.calls.length;
    resolve(
      mockNeural as unknown as Awaited<
        ReturnType<typeof createNeuralGazeRuntime>
      >,
    );
    await pending;
    await flush();
    expect(finishedBeforeLateModel).toBe(true);
    expect(faceClosedAtStop).toBe(1);
    expect(mockNeural.close).toHaveBeenCalledOnce();
    expect(mockRuntime.detector.close).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("times out fallback loading once and disposes a face model arriving afterwards", async () => {
    vi.useFakeTimers();
    let resolve!: (
      runtime: Awaited<ReturnType<typeof createFaceDetector>>,
    ) => void;
    vi.mocked(createFaceDetector).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { tracker, video, track, onError } = camera();
    let failure: unknown = null;
    const pending = tracker.start(video, vi.fn(), onError).catch((error) => {
      failure = error;
    });
    await flush();
    await vi.advanceTimersByTimeAsync(45_001);
    const failureAtDeadline = failure;
    resolve(
      mockRuntime as unknown as Awaited<ReturnType<typeof createFaceDetector>>,
    );
    await pending;
    await flush();
    tracker.stop();
    expect(failureAtDeadline).toBeInstanceOf(Error);
    expect((failureAtDeadline as Error).message).toMatch(/timed out/i);
    expect(onError).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(mockRuntime.detector.close).toHaveBeenCalledOnce();
    expect(createNeuralGazeRuntime).not.toHaveBeenCalled();
    expect(tracker.getDiagnostics().running).toBe(false);
  });

  it("turns a bad worker prediction into one safe runtime stop", async () => {
    const workers: ReadyWorker[] = [];
    class ReadyWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: unknown = null;
      terminate = vi.fn();
      postMessage = vi.fn((message: { type: string }) => {
        if (message.type === "init")
          queueMicrotask(() =>
            this.onmessage?.({
              data: { type: "ready", delegate: "CPU" },
            } as MessageEvent),
          );
      });
      constructor() {
        workers.push(this);
      }
    }
    vi.stubGlobal("Worker", ReadyWorker);
    vi.stubGlobal("createImageBitmap", vi.fn());
    const { tracker, video, track, onError } = camera();
    await tracker.start(video, vi.fn(), onError);
    tracker.setCalibration({
      version: 1,
      featureCount: 18,
      means: Array(18).fill(0),
      scales: Array(18).fill(1),
      weightsX: Array(19).fill(0),
      weightsY: Array(19).fill(0),
      samples: 9,
      createdAt: 1,
    });
    vi.spyOn(faceFeatures, "extractFaceFeatures").mockReturnValueOnce({
      features: Array(8).fill(0),
      quality: 1,
      reason: "Visible",
      gestures: { jawOpen: 0, browInnerUp: 0, mouthSmile: 0 },
    });
    vi.spyOn(calibration, "predictCalibration").mockImplementationOnce(() => {
      throw new Error("Invalid calibration prediction.");
    });
    const deliver = () =>
      workers[0].onmessage?.({
        data: {
          type: "result",
          timestamp: performance.now(),
          result: { faceLandmarks: [[]], faceBlendshapes: [] },
          neural: {
            raw: { x: 0.5, y: 0.5 },
            keypoints: Array(8).fill(0),
            inferenceMs: 1,
          },
        },
      } as MessageEvent);
    let thrown: unknown;
    try {
      deliver();
    } catch (error) {
      thrown = error;
    }
    tracker.stop();
    expect(thrown).toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      "Invalid calibration prediction.",
    );
    expect(track.stop).toHaveBeenCalledOnce();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(tracker.getDiagnostics().running).toBe(false);
  });

  it("does not let a cancelled inference unlock a newer session's in-flight frame", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    let oldResult!: (value: null) => void;
    let newResult!: (value: null) => void;
    mockNeural.predict.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          oldResult = resolve;
        }),
    );
    const newNeural = {
      close: vi.fn(),
      images: { mirror: vi.fn() },
      predict: vi.fn(
        () =>
          new Promise<null>((resolve) => {
            newResult = resolve;
          }),
      ),
    };
    vi.mocked(createNeuralGazeRuntime)
      .mockResolvedValueOnce(
        mockNeural as unknown as Awaited<
          ReturnType<typeof createNeuralGazeRuntime>
        >,
      )
      .mockResolvedValueOnce(
        newNeural as unknown as Awaited<
          ReturnType<typeof createNeuralGazeRuntime>
        >,
      );
    mockRuntime.detector.detectForVideo.mockReturnValue({
      faceLandmarks: [],
      faceBlendshapes: [],
    });
    const { tracker, video, onError } = camera();
    Object.assign(video, {
      readyState: 2,
      currentTime: 1,
      videoWidth: 640,
      videoHeight: 480,
    });
    await tracker.start(video, vi.fn(), onError);
    frames.at(-1)!(performance.now() + 100);
    await flush();
    expect(mockNeural.predict).toHaveBeenCalledOnce();
    tracker.stop();
    await tracker.start(video, vi.fn(), onError);
    frames.at(-1)!(performance.now() + 200);
    await flush();
    expect(newNeural.predict).toHaveBeenCalledOnce();
    oldResult(null);
    await flush();
    Object.assign(video, { currentTime: 2 });
    frames.at(-1)!(performance.now() + 300);
    await flush();
    const callsBeforeNewResult = newNeural.predict.mock.calls.length;
    newResult(null);
    await flush();
    tracker.stop();
    expect(callsBeforeNewResult).toBe(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("still releases the camera and clears state when model teardown throws", async () => {
    const { tracker, video, track, onError } = camera();
    await tracker.start(video, vi.fn(), onError);
    mockRuntime.detector.close.mockImplementationOnce(() => {
      throw new Error("Detector already closed.");
    });
    mockNeural.close.mockImplementationOnce(() => {
      throw new Error("Neural runtime already closed.");
    });
    let thrown: unknown;
    try {
      tracker.stop();
    } catch (error) {
      thrown = error;
    }
    const trackClosedAfterStop = track.stop.mock.calls.length;
    const videoAfterStop = video.srcObject;
    const runningAfterStop = tracker.getDiagnostics().running;
    tracker.stop();
    expect(thrown).toBeUndefined();
    expect(trackClosedAfterStop).toBe(1);
    expect(videoAfterStop).toBeNull();
    expect(runningAfterStop).toBe(false);
    expect(mockRuntime.detector.close).toHaveBeenCalledOnce();
    expect(mockNeural.close).toHaveBeenCalledOnce();
    expect(track.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mockRuntime.detector.close.mock.invocationCallOrder[0],
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("releases every remaining track even if one track's stop throws", async () => {
    const { tracker, video } = camera();
    const first = {
      stop: vi.fn((): void => {
        throw new Error("Track already ended.");
      }),
      addEventListener: vi.fn(),
    };
    const second = { stop: vi.fn(), addEventListener: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [first, second],
          getVideoTracks: () => [first, second],
        }),
      },
    });
    await tracker.start(video, vi.fn(), vi.fn());
    let thrown: unknown;
    try {
      tracker.stop();
    } catch (error) {
      thrown = error;
    }
    const secondClosed = second.stop.mock.calls.length;
    first.stop.mockImplementation(() => {});
    tracker.stop();
    expect(thrown).toBeUndefined();
    expect(secondClosed).toBe(1);
    expect(video.srcObject).toBeNull();
    expect(tracker.getDiagnostics().running).toBe(false);
  });

  it("clears ownership before notifying a consumer that itself throws on stop", async () => {
    const { tracker, video, track } = camera();
    let runningDuringNotification: boolean | null = null;
    const observe = vi.fn(() => {
      runningDuringNotification = tracker.getDiagnostics().running;
      throw new Error("Consumer callback failed.");
    });
    await tracker.start(video, observe, vi.fn());
    expect(() => tracker.stop()).not.toThrow();
    expect(runningDuringNotification).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    expect(() => tracker.stop()).not.toThrow();
    expect(observe).toHaveBeenCalledOnce();
  });
});
