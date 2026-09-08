# Webcam gaze: model selection and evidence boundaries

Reviewed 8 September 2026 against upstream code, model artifacts, and license files. This is a browser-local engineering prototype. No result below establishes gaze accuracy for Nerve, a particular camera, or a particular person.

## Why the first estimator was not enough

MediaPipe detects face and iris geometry. Google explicitly distinguishes iris tracking from determining where somebody is looking. Mapping a few landmark ratios to a screen can fail because of head pose, eye appearance, camera placement, reflections, and calibration noise. A detected face is not evidence of accurate gaze. [Google's Iris documentation](https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/iris.md)

The appropriate upgrade is an appearance-based gaze model plus person-and-session calibration, not a larger language-model prompt. Astra should interpret an intentionally selected task and computer context. It should not receive webcam frames or pretend to recover information the camera did not capture.

## Primary-source comparison

| Candidate    | Actual implementation and artifact                                                                                                                  | License/provenance checked                                                                                                                                                                            | Decision for Nerve                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Peekr        | Two eye-image inputs plus eye-box geometry, pretrained ONNX model, browser worker example. Checked-in model is 579,176 bytes.                       | MIT repository, including the checked-in model; no separate model restriction found. Attribution must be preserved.                                                                                   | Selected as a small appearance-based feature source for browser-local calibration.             |
| WebEyeTrack  | TypeScript, TensorFlow.js CNN, head-pose features and on-device adaptation. Browser weights are 624,072 bytes plus a 44,988-byte model description. | MIT code. Repository also contains a pretrained file named `blazegaze_mpiifacegaze.keras`; model-training provenance needs separate review before broad redistribution.                               | Credible alternative, but adds a second ML stack and a larger geometry/adaptation integration. |
| WebGazer     | Browser eye-image regression with calibration from user interaction.                                                                                | Current `LICENSE.md` says GPLv3-or-later. Older descriptions of conditional LGPL availability are not the current license file.                                                                       | Established baseline, not a license-transparent drop-in dependency.                            |
| EyeGestures  | Current v4 documentation describes a Rust engine with Python and browser interfaces.                                                                | GPLv3 repository; browser examples reference external hosted scripts.                                                                                                                                 | Relevant prior art. Not integrated by adding unpinned CDN scripts to a local-private app.      |
| L2CS-Net     | PyTorch gaze-angle estimator; pretrained snapshots are linked from Google Drive.                                                                    | MIT code does not establish unrestricted rights in every pretrained weight or training dataset.                                                                                                       | Useful research reference, not a ready screen-coordinate browser controller.                   |
| MobileGaze   | L2CS-derived ONNX exports. MobileOne S0 is 4,974,521 bytes; MobileNet V2 is 9,790,767 bytes.                                                        | MIT code, but README says all provided models were trained on Gaze360. Gaze360's license explicitly restricts dataset-trained models and other derivatives to research use and limits redistribution. | Do not bundle its pretrained weights as unrestricted public-app assets.                        |
| GazeTracking | Python/OpenCV/dlib pupil localization and left/center/right ratios. Its 68-point dlib landmark artifact is 99,693,937 bytes.                        | MIT application code. A code license alone is not a complete model-provenance assessment.                                                                                                             | Not a pretrained screen-gaze upgrade, and a poor fit for this browser runtime.                 |
| EyeTrax      | Python MediaPipe features with session-trained regression; calibration and Kalman/EMA/KDE options.                                                  | MIT code.                                                                                                                                                                                             | Useful reference for geometric normalization and calibration; not a browser appearance model.  |

Sources for the table:

- Peekr: [repository and architecture](https://github.com/HugoFara/peekr), [MIT license](https://github.com/HugoFara/peekr/blob/d3ea61e4a34ce9463d83979c286ba9a8712b514a/LICENSE), [checked-in ONNX artifact](https://github.com/HugoFara/peekr/blob/d3ea61e4a34ce9463d83979c286ba9a8712b514a/public/peekr.onnx).
- WebEyeTrack: [TypeScript implementation](https://github.com/RedForestAi/WebEyeTrack/tree/main/js), [browser model artifacts](https://github.com/RedForestAi/WebEyeTrack/tree/main/js/examples/minimal-example/public/web), [pretrained Python weights](https://github.com/RedForestAi/WebEyeTrack/tree/main/python/webeyetrack/model_weights), [MIT license](https://github.com/RedForestAi/WebEyeTrack/blob/main/LICENSE).
- WebGazer: [source](https://github.com/brownhci/WebGazer), [current license](https://github.com/brownhci/WebGazer/blob/master/LICENSE.md).
- EyeGestures: [v4 implementation and setup](https://github.com/NativeSensors/EyeGestures), [license](https://github.com/NativeSensors/EyeGestures/blob/main/LICENSE).
- L2CS-Net: [official implementation and weight links](https://github.com/Ahmednull/L2CS-Net).
- MobileGaze: [model and dataset description](https://github.com/yakhyo/gaze-estimation), [downloadable release assets](https://github.com/yakhyo/gaze-estimation/releases/tag/weights), [Gaze360 license](https://github.com/erkil1452/gaze360/blob/master/LICENSE.md).
- GazeTracking: [actual ratio estimator](https://github.com/antoinelame/GazeTracking/blob/master/gaze_tracking/gaze_tracking.py), [landmark model](https://github.com/antoinelame/GazeTracking/tree/master/gaze_tracking/trained_models).
- EyeTrax: [implementation and calibration options](https://github.com/ck-zhang/EyeTrax), [geometric feature extraction](https://github.com/ck-zhang/EyeTrax/blob/main/src/eyetrax/gaze.py).

## Selected model and reproducibility

The selected Peekr artifact is pinned to commit `d3ea61e4a34ce9463d83979c286ba9a8712b514a`:

- [Direct artifact](https://raw.githubusercontent.com/HugoFara/peekr/d3ea61e4a34ce9463d83979c286ba9a8712b514a/public/peekr.onnx)
- Size: `579176` bytes
- SHA-256: `9abc6c98ee02ee518da98777d1cd879ff9bbaf71491ed2c803a608e9740ce7fb`
- Copyright: `Copyright (c) 2025 AryamanTaore`
- License: MIT, with the upstream copyright and permission notice retained alongside the integration.

This hash was computed from the downloaded upstream artifact. It is a reproducibility check, not a publisher signature or independent assurance about the training data. The repository applies MIT terms and describes a separately collected desktop-webcam training set; we did not independently audit that dataset's consent or provenance.

The integration deliberately does not import the upstream demo's camera lifecycle or calibration UI. Those must fit Nerve's explicit camera permission, emergency stop, frame-backpressure, and independent-validation requirements.

## Exact preprocessing contract

The ONNX input names are `input1`, `input2`, and `kps`. The eye tensors have shape `[1, 3, 128, 128]`, planar BGR channel order, and values divided by 255. The geometry tensor has shape `[1, 8]`, containing two normalized eye boxes as `x, y, width, height`. Upstream uses landmark groups `[130, 27, 243, 23]` and `[463, 257, 359, 253]`. [Pinned preprocessing source](https://github.com/HugoFara/peekr/blob/d3ea61e4a34ce9463d83979c286ba9a8712b514a/src/eyetracking.js), [pinned inference worker](https://github.com/HugoFara/peekr/blob/d3ea61e4a34ce9463d83979c286ba9a8712b514a/src/worker.js)

Upstream enables legacy FaceMesh `selfieMode`. Its published implementation maps this option to a `GlScalerCalculator` horizontal flip. Its eye crop then maps the mirrored box back into the original camera image using `rawX = frameWidth - mirroredX - boxWidth`. Preserving that coordinate contract matters. Simply flipping landmark x values without accounting for eye ordering can reverse the boxes. [Published FaceMesh implementation](https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/face_mesh.js)

The model's two outputs are learned gaze features, not permission to click and not already validated viewport coordinates. The upstream demo performs an additional scale-and-offset calibration. Nerve should calibrate against the current browser viewport, not the physical display dimensions, and must not clamp away out-of-range predictions before evaluating them. [Upstream calibration implementation](https://github.com/HugoFara/peekr/blob/d3ea61e4a34ce9463d83979c286ba9a8712b514a/src/index.js)

## What a trustworthy calibration must establish

1. Allow time to find each target before collecting a stable window. Reject invalid, stale, closed-eye, and moving samples rather than counting every frame as useful.
2. Fit on training targets only. Keep an independent set of target observations out of fitting and model selection.
3. Report both accuracy and variation, including the target locations that failed. A single vague failure message is not actionable.
4. Treat camera geometry and the viewport as part of the calibration session. Resizing, camera replacement, or a substantial pose change can invalidate the mapping.
5. Keep uncertain gaze from activating controls. Better-looking plots, smoothing, or weaker thresholds are not evidence of increased accuracy.
6. Separate locating a control from authorizing an action. Keep a reliable switch/pointer path and an immediately available stop control.

## What we can and cannot claim

Real model loading, tensor-contract tests, synthetic calibration tests, and browser lifecycle tests can establish that the implementation runs and respects its boundaries. They cannot establish a human gaze-accuracy improvement.

Peekr and WebEyeTrack publish their own evaluation descriptions. Those results use their own devices, data, calibration, and participants. They must not be advertised as Nerve benchmarks. In particular, the [WebEyeTrack paper](https://arxiv.org/abs/2508.19544) discusses on-device adaptation and reports results on GazeCapture; those are not interchangeable with this app's normalized-viewport error.

The next real measurement is the user's independent target check, followed by repeated intended-target selections with recorded misses and accidental activations. Testing should include glasses, lighting changes, comfortable posture differences, and the intended access needs. No medical-grade, universal-accessibility, mind-reading, or frontier-AGI gaze claim is justified by this integration. See [EVALUATION.md](EVALUATION.md) and [SAFETY.md](SAFETY.md).
