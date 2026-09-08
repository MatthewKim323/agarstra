# Changelog

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
