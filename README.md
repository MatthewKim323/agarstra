# Nerve

**A little intent. A lot more possible.**

The app is called **Nerve**; its public hackathon repository is [intentions](https://github.com/MatthewKim323/intentions).

Nerve is a local-first assistive computer-use interface. A person indicates a region or selects a suggested intent with a pointer, a single switch, or calibrated webcam input. The system previews the exact browser actions, waits for explicit approval, executes them in a fresh isolated Chromium session, then observes the result.

This is working software, not mind reading. Webcam gaze is experimental, and this project has not been validated with people with disabilities. It does not read thoughts, infer emotions, diagnose conditions, or provide medical-grade eye tracking.

## Start

Requirements: Node.js 22.12 or newer (Node 24 recommended), npm, and a current Chromium-based browser. macOS, Linux, and Windows are supported by the underlying browser tooling. This checkout was tested on macOS.

```sh
git clone https://github.com/MatthewKim323/intentions.git
cd intentions
npm ci
npm run setup
npm run dev
```

Open **http://127.0.0.1:4317**. Click **Start practice**. No API key or camera is needed.

Already have this checkout? Skip the clone and change into its directory. For the first complete task, camera setup, switch controls, and live Astra setup, follow the [quickstart](docs/QUICKSTART.md).

`npm run setup` installs isolated Chromium and downloads the pinned Google Face Landmarker model plus local WASM assets. It never opens the camera. After setup, practice mode and webcam processing do not require a third-party CDN. Fonts are bundled locally.

For the built application:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:4318**. The UI and local bridge are served together. On macOS, `Launch Nerve.command` builds and opens the application when double-clicked. Close its terminal or press Ctrl+C to stop its server.

## What works

- Real isolated-browser screenshots and UI actions, not a simulated success animation.
- Practice email drafting, note saving, and reversible archiving, with independent state verification. Practice recipes are deterministic and labeled as such.
- Astra intent suggestions based on the current screen and an optional coarse attention region.
- GPT-6 Astra native computer-use actions through the Responses API, with explicit screenshot consent and bounded execution.
- Single-switch scanning with Space, including intent selection, confirmation, action approval, cancellation, stop, resume, and dialog controls. Tab/Enter always remain available.
- Optional camera input: local face landmarks and iris/head features, ridge-regression calibration, held-out validation targets, timestamp-aware smoothing, deliberate gesture calibration, hysteresis, and release-to-rearm.
- Temporal spatial evidence and ambiguity gating. Gaze only highlights; deliberate input selects. Scores are heuristic, not calibrated probabilities of intent.
- One-use, expiring action approvals tied to the screen revision. A changed screenshot invalidates approval.
- Always-visible emergency stop, page-hidden stop, stale-input rejection, and cancellation checks between actions.
- Local preferences, optional spoken choices, higher contrast, larger text, reduced-motion support, and downloadable session logs without video, screenshots, or credentials.

## Astra connection

Provide `OPENAI_API_KEY` in the server process environment. Copy `.env.example` to `.env` if needed; both development and production startup load `.env` without overriding environment values. Never commit `.env`.

Then choose **Connect Astra**, review the screenshot-sharing consent, and start a session. Leave the starting page blank to test Astra against the synthetic local mail/notes environment.

The model ID is exactly `gpt-6-astra`; Nerve does not silently substitute another model. Having a key does not guarantee that the account can access that model. Provider failures are shown as errors, never relabeled as successful practice runs.

Only browser screenshots and selected task text go to OpenAI. Camera frames, face landmarks, gaze calibration, and gesture samples do not. `store: false` is used; the provider's account policies still govern handling and retention.

An optional external starting page must be HTTPS on the default port and resolve to public addresses. The browser pins an approved address and only permits the approved origin. Third-party assets, cross-origin authentication, new tabs, downloads, WebSockets, internal addresses, and the host desktop are blocked. This deliberately restricts compatibility. Use synthetic data first.

## Input guide

### Pointer

Click inside the screenshot to indicate a region. This **does not click the remote browser**. Choose **Read this screen** for contextual suggestions, select an intent, confirm it, then review the proposed action.

### Single switch

Select **Single switch**. Connect a switch configured to emit Space, or use the spacebar. The highlight advances automatically. Press once to select. Holding the key does not repeatedly activate. Adjust the interval under Settings. Range settings advance by one step when selected and wrap at their maximum. Free-text tasks are an optional keyboard-input feature, not required for the main workflows.

### Camera

Select **Camera**, then **Enable camera**. Permission is requested only then. Follow the nine calibration targets and five held-out validation targets. If validation is rejected, gaze input is not enabled. Teach one comfortable gesture using separate resting and active samples. Ordinary blinking is not used as a click.

Look at an available control until highlighted, then make the calibrated gesture. Release before selecting again. Looking inside the browser screenshot sets a coarse attention region for **Read this screen**, not a remote click. Camera estimates do not prove intent and can be wrong. Recalibrate after moving the camera, changing posture, or resizing the viewport. Switching away from camera stops capture. Calibration is session-only, not automatically restored from saved preferences.

### Stop

**Emergency stop** is pinned to the workspace and is also present inside setup dialogs, including camera calibration. It is prioritized in dialog scanning. Escape works globally, including inside text fields. Stop invalidates approvals and prevents remaining queued actions. It cannot undo input already dispatched to the browser. Resume re-enables selection; it does not restart the stopped task.

The displayed browser view is the last captured screenshot. After Stop, choose Resume and then **Read this screen** to refresh that view without executing an action.

## Test and verify

```sh
npm test
npm run build
npm run test:e2e
npm audit
```

Unit tests cover calibration math, independent validation, gesture rearming, stale input, intent ambiguity, scanner behavior, action validation, request-origin restrictions, public-address filtering, provider schema parsing, and approval/cancellation races.

End-to-end tests use real Chromium to check sample-app outcomes, no-execution-before-approval, one-use approval, switch-only operation, camera denial fallback, accessibility, responsive layout, and log export. Tests are serialized because the bridge owns one active session. Do not interact with the local UI while running the suite.

Live provider tests are separately opt-in, use only synthetic local data, and incur API usage. Start the bridge first, then run:

```sh
NERVE_LIVE_TEST=1 npx tsx tests/server-live-smoke.ts
```

The script automatically approves actions only in its own isolated synthetic workspace. It must not be repurposed for real accounts. The API key must be in the script's environment. See [recorded verification](docs/VERIFICATION.md) for measured results and limitations.

## Architecture

```text
camera frames -> local vision worker -> calibrated observation
switch / pointer --------------------------+        |
                                           v        v
                                  intent + ambiguity gate
                                           |
                                  deliberate goal selection
                                           |
                           practice recipe OR Astra screenshot loop
                                           |
                            exact preview + one-use user approval
                                           |
                          validated actions -> isolated Chromium
                                           |
                             fresh screenshot + outcome check
```

- `src/vision`: local MediaPipe worker, feature extraction, calibration, smoothing, deliberate-gesture detector.
- `src/core`: temporal intent ranking, dwell, scanning, and profile validation.
- `src/App.tsx`, `src/components`: accessible interface, input selection, calibration workflow.
- `server/session.ts`: cancellable state machine and authorization boundary.
- `server/provider.ts`: Astra Responses API, structured intent suggestions, computer calls.
- `server/browser.ts`: constrained Playwright executor; no arbitrary model-generated code execution.
- `server/security.ts`: loopback request guards and browser network policy.
- `server/lab.ts`: actual synthetic mail and notes application.

## Boundaries

This release controls its isolated browser, not arbitrary applications on your desktop. Local services are single-user and must not be exposed through a tunnel or to a public network. The UI does not authenticate different local OS users or local processes. The practice workspace is disposable, and Reset discards its data. External completion is labeled as Astra's report and requires checking the resulting screen; it is not independently verified in every possible application.

See [research and sources](docs/RESEARCH.md), [safety and privacy](docs/SAFETY.md), [evaluation protocol](docs/EVALUATION.md), [API contract](docs/API.md), and [demo guide](docs/DEMO.md).

## Troubleshooting

| Symptom                               | Check                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| Local bridge disconnected             | Run `npm run dev`; ports 4317 and 4318 must be available.                             |
| Bridge was restarted during a session | Reload the interface to begin a fresh client session. Old proposals are not reusable. |
| Chromium unavailable                  | Run `npm run setup`. Linux hosts may also need Playwright system dependencies.        |
| Camera denied                         | Allow the site in browser camera settings, or continue with switch/pointer.           |
| Model assets unavailable              | Re-run `npm run setup`, then reload. No CDN fallback silently uploads data.           |
| Gaze check fails                      | Improve lighting, stabilize camera/posture, retry without strain, or use a switch.    |
| Astra access error                    | Check key/model entitlement. Nerve never switches models without your choice.         |
| Page fails to load                    | External-origin restrictions may block its dependencies or redirects.                 |
| Proposal rejected as stale            | The screen changed. Request a fresh intent; do not bypass the check.                  |
| Stop happened while away              | Hiding the page stops the task intentionally. Resume and choose a new intent.         |

Third-party packages and model assets retain their respective licenses. No clinical safety, reliability, or accuracy claims are made.
