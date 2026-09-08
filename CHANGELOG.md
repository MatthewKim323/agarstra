# Changelog

## Gaze upgrade - 2026-09-08

### Added

- Pretrained Peekr appearance-based gaze inference with pinned, hash-verified weights and locally served ONNX WASM. Eye images never leave the device.
- An 18-feature personal mapping combining eye appearance and geometry, with robust target-balanced fitting and training-only whole-target model selection.
- Untimed calibration instructions, explicit start, fixation-aware sample collection, and separate per-target offset and jitter results.
- Opt-in numeric diagnostic downloads without images, raw eye features, or fitted model weights.
- Real local neural-inference, production-camera, and camera lifecycle regression tests.
- Gaze-model research, provenance, third-party notices, and updated setup and evaluation guidance.

### Changed

- Renamed the public GitHub repository from `intentions` to `agarstra`. The app remains Nerve.
- Explain which accuracy threshold failed rather than calling every failed calibration unstable. Mean `0.150` and 95th-percentile `0.255` limits are unchanged.
- Score cross-validation and independent checks before clipping predictions to the screen, so out-of-screen errors cannot be hidden.
- Bound and cancel model initialization, isolate teardown failures, and keep exclusive ownership of in-flight worker frames.
- Explicitly disclose that live intent suggestions can share a coarse attention point with Astra, while camera frames and calibration remain local.
- Upgrade Vitest to 4.1.11 to address the reported dependency advisory.

### Limits

- Automated tests use synthetic inputs. Human accuracy after this upgrade remains unmeasured.
- A failed independent check still leaves gaze actions disabled; pointer and switch input remain available.

## 0.1.0 - 2026-09-08

Initial hackathon release of Nerve in the `intentions` repository.

### Added

- Choose browser tasks using suggested intents, a pointer, a single switch, or experimental calibrated webcam input.
- Combine uncertain attention signals with explicit selection instead of treating gaze as permission.
- Calibrate coarse gaze against held-out targets and teach a deliberate facial gesture with release-to-rearm protection.
- Keep webcam inference local using pinned MediaPipe assets, with permission handling and camera cleanup.
- Preview exact computer actions, approve each one-use batch, and stop or cancel pending work.
- Run real isolated Chromium tasks with strict action validation, approved-origin restrictions, and localhost request guards.
- Draft replies, save notes, and archive synthetic messages in no-key practice mode with independent outcome checks.
- Connect Astra for screenshot-based intent suggestions and native computer-use actions after explicit screen-sharing consent.
- Adjust scanning, contrast, text size, and spoken choices; save local preferences and export session logs without screenshots or credentials.
- Start a built local app with the cross-platform launcher or the macOS command file.
- Verify behavior with unit tests, real-browser tests, and a separately opt-in synthetic live-model harness.
- Reproduce checks through GitHub Actions and follow the quickstart, demo, API, research, safety, and evaluation documentation.

### Limits

- This release controls its isolated browser, not the host desktop.
- Human webcam accuracy and accessibility outcomes have not been validated in participant studies.
- Practice tasks are deterministic. Live-model results are separately labeled and documented.
