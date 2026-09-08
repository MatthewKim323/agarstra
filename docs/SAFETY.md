# Safety, privacy, and operating boundaries

Nerve is a local-first, single-user accessibility research prototype. It is not suitable for emergency communication, medical decisions, financial transactions, or unsupervised operation of important accounts. Keep another reliable way to stop the computer available during evaluation.

## Permission is separate from prediction

An intent score is a ranking signal, not permission. A selected intent produces a proposal; approval authorizes only that proposal. Looking at a choice, reading a screen, losing tracking, or allowing camera access must not authorize a computer action.

The intended state transition is:

`observe -> select intent -> review proposal -> approve -> execute bounded actions -> inspect outcome`

Cancel discards the proposal. Emergency stop invalidates outstanding work and prevents later approval of that work. It is not an undo operation: an action already delivered to the browser might already have taken effect. Inspect the resulting screen before resuming.

## Data boundaries

| Data                           | Boundary                                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webcam video and landmarks     | Processed in the local page. Camera input is optional. Do not add analytics or upload frames.                                                                                                            |
| Calibration/profile            | Camera calibration stays in memory for this session; it is not uploaded or automatically restored. General interface preferences are saved in local browser storage. Recalibrate when the setup changes. |
| Browser screenshots            | Displayed locally. In live Astra mode, task screenshots are transmitted to the configured model service only after screen-sharing consent.                                                               |
| Task text and proposed actions | Held by the local app/server; sent to the model service in live mode. Avoid credentials, health records, and other sensitive material.                                                                   |
| API credential                 | Server environment only. Never enter it into a target page or expose it in frontend source, audit exports, screenshots, or error messages.                                                               |
| Exported session log           | User-created local file. Review before sharing; task descriptions and audit events may contain private text.                                                                                             |

Browser camera permission and model screen-sharing consent are different permissions. Camera denial must leave non-camera input usable. Camera tracks should stop when the camera mode is stopped or the page is disposed. Browser permission can also be revoked in browser settings. Media-capture permission and track lifecycle are specified separately by the platform. [W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)

Local-first does not mean every mode is offline: initial dependency/model setup downloads software assets, and Astra mode sends screenshots and task context to its API. Provider data handling and retention are governed by the account's settings and terms, not by this document.

## Threat model and release checks

The supported default environment is a fresh Chromium session controlling the bundled practice workspace. It must not reuse the user's normal browser profile, cookies, downloads, or logins. Do not expose the local bridge to a LAN or the public internet.

| Failure or abuse                                           | Required control                                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Malicious page asks the model to change its mission        | Treat page content as untrusted; it cannot grant permissions. Restrict destinations and executable actions outside the prompt.                   |
| Unwanted activation from an ordinary look or movement      | Separate selection from approval; use dwell/gesture thresholds and release gating; preserve pause and alternative input.                         |
| Stale proposal executes on a different screen              | Bind approval to proposal ID, screen/session revision, and expiration. Re-propose after state changes.                                           |
| An old status response restores an approval after stopping | Ignore responses from superseded requests and reject state revisions older than the current state.                                               |
| A footer or overlay hides a gaze target                    | Exclude offscreen targets and targets whose visible center fails browser hit-testing; leave scroll clearance around scanned controls.            |
| Double click or switch repeats approval                    | One-use proposals and serialized execution.                                                                                                      |
| Stop arrives during work                                   | Abort pending model work where possible, invalidate outstanding approval, check stop state between actions, and expose the final observed state. |
| Arbitrary browser navigation or data exfiltration          | Default-deny network destinations, fresh browser context, popup/download restrictions, no access to the host desktop.                            |
| Another website reaches the localhost bridge               | Loopback binding plus request origin/host and mutation-request guards. Loopback alone is not authentication.                                     |
| Model invents successful completion                        | Verify the browser's actual state. Label unverified completion honestly.                                                                         |
| Invalid coordinates or action payload                      | Validate schema, action allowlist, bounds, and limits server-side.                                                                               |
| Absent model key or camera                                 | A clearly labeled no-key practice path and non-camera input, never a fake live result.                                                           |

These controls follow the official recommendation to isolate, confirm, bound, and verify computer-use systems. They reduce risk but do not establish that arbitrary external websites are safe. [OpenAI computer-use safety](https://developers.openai.com/api/docs/guides/tools-computer-use#run-safely)

The current bridge also compares a fresh screenshot with the proposal's screenshot before dispatch. Any difference invalidates that proposal. This is intentionally conservative: animated pages, timers, or other changing content can cause repeated rejection even when the intended control is unchanged. External sessions allow only the explicitly selected HTTPS origin, so third-party resources, redirects, popups, and many login flows may not work. This release is not a general unrestricted desktop controller.

## Camera and input limitations

- A webcam estimate can drift or fail without being obviously wrong. Validate it against targets before relying on it.
- Low quality or missing observations reset dwell rather than accumulating invisible activation time.
- A natural blink must not be treated as blanket consent. Sustained gestures may still be uncomfortable or unavailable.
- Pause and emergency stop must be available through accessible controls, not only a mouse.
- Setup dialogs include their own Emergency stop control, prioritized by the switch scanner. The camera calibration overlay also retains this control; the page-level footer alone is not accessible through a native modal dialog.
- Disable dwell and use explicit switch or pointer input if camera behavior is unreliable. Do not lower thresholds merely to produce a more dramatic demo.
- Recalibrate after moving the camera or changing viewport geometry. A fit error on the same calibration data is not an independent accuracy measurement.

## Before involving another person

Explain what is measured, what leaves the device, and how to stop. Let the person choose a comfortable input and decline camera use. Use fictional task data. Stop when requested or when fatigue/discomfort appears. Do not ask participants to simulate an impairment or present developer trials as disability-user validation.

Formal studies, clinical claims, deployment into care settings, or storage of participant data require appropriate consent, privacy review, and domain expertise. None is implied by the demo.
