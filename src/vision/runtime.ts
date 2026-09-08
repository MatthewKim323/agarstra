import type { FaceLandmarker } from "@mediapipe/tasks-vision";

export type DetectorRuntime = {
  detector: FaceLandmarker;
  delegate: "GPU" | "CPU";
};

/** Assets resolve locally. Nothing from a user's camera is sent to a model server. */
export async function createFaceDetector(): Promise<DetectorRuntime> {
  const { FaceLandmarker, FilesetResolver } = await import(
    "@mediapipe/tasks-vision"
  );
  const files = await FilesetResolver.forVisionTasks("/vision/wasm");
  const options = {
    runningMode: "VIDEO" as const,
    numFaces: 2,
    minFaceDetectionConfidence: 0.65,
    minFacePresenceConfidence: 0.65,
    minTrackingConfidence: 0.65,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  };
  try {
    return {
      detector: await FaceLandmarker.createFromOptions(files, {
        ...options,
        baseOptions: {
          modelAssetPath: "/vision/face_landmarker.task",
          delegate: "GPU",
        },
      }),
      delegate: "GPU",
    };
  } catch {
    return {
      detector: await FaceLandmarker.createFromOptions(files, {
        ...options,
        baseOptions: {
          modelAssetPath: "/vision/face_landmarker.task",
          delegate: "CPU",
        },
      }),
      delegate: "CPU",
    };
  }
}
