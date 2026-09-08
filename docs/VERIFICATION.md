# Verification record

Tested 8 September 2026 on macOS, Node.js 24.7.0, Chromium through Playwright 1.63.0. These are implementation checks, not disability-user trials or a general benchmark of model ability.

## Final release gate

After source formatting and the fresh-screen fix, `npm run check` completed successfully:

| Check                                  | Result                     |
| -------------------------------------- | -------------------------- |
| Unit tests                             | 163 passed across 12 files |
| Strict TypeScript and production build | Passed                     |
| Real Chromium browser tests            | 26 passed in 1.4 minutes   |
| Dependency audit                       | 0 reported vulnerabilities |

The browser suite includes actual practice outcomes, switch-only operation, local synthetic-camera startup and restart, calibration target clearance, in-dialog emergency stops, and automated accessibility checks. The workspace was reset to a clean entry state after testing. Live model runs are recorded separately below.

## Live Astra, synthetic workspace

Actual requests to `gpt-6-astra` used the Responses API with native computer actions, reasoning effort `low`, and `store: false`. Each task had its own fresh browser session. No personal accounts or messages were used. The opt-in harness approved proposals only after checking that the controlled browser remained on the local synthetic workspace.

| Task                                   | Provider responses | Approval batches | Primitive actions | Elapsed        | Independently checked result                                  |
| -------------------------------------- | ------------------ | ---------------- | ----------------- | -------------- | ------------------------------------------------------------- |
| Archive selected message               | 3                  | 2                | 2                 | 10.960 seconds | The selected message ID existed in the saved archive state    |
| Draft reply confirming tomorrow at 3pm | 4                  | 3                | 5                 | 13.459 seconds | Saved draft contained substantive text and the requested time |

All seven task responses returned HTTP 200. These are single observed runs, not average latencies, reliability estimates, or human completion times. The elapsed time includes browser setup and automatic test approvals, not human approval time.

A separate live screenshot-suggestion request returned three validated intents: Draft a reply, Save a meeting note, and Summarize the invitation. Source was `astra`, normalized weights totaled one, and no computer action was executed. These weights are heuristic, not calibrated intent probabilities.

Reproduction harness: `tests/server-live-smoke.ts`. Provider output can vary between runs. This evidence establishes live integration on the tested tasks, not superiority over other models.

## Camera runtime

The browser suite starts actual MediaPipe and local WASM using Chromium's generated fake-camera device. It checks local model loading, absence of external requests during that flow, and stopped media tracks after stopping capture. A second fixture closes setup while permission is pending, then confirms that a late-granted stream is stopped.

No real webcam was opened by these checks. The generated video is not a human face. Human gaze accuracy, gesture comfort, calibration acceptance rates, and real hardware behavior remain unmeasured.

## Automated evidence

Unit tests cover calibration and independent validation math, quality thresholds, gesture release/rearm, stacked-control ambiguity, camera cleanup races, switch controls, schema rejection, network boundaries, live-response parsing, and cancellation/approval state transitions.

Browser tests exercise actual practice draft, note, and archive state; approval-before-action; stale/repeated approval rejection; Escape and Stop; switch-only drafting and resuming; camera permission denial and synthetic runtime; saved preferences and export; responsive layout; and automated accessibility checks.

Additional regressions cover the very first switch press, repeated-input suppression, stale poll responses after Stop, secondary navigation and consent through scanning, exclusion of obscured gaze targets, and fresh screenshot capture with cancellation guards before generating suggestions.

Accessibility checks use axe for WCAG A/AA rules on tested entry, setup, active camera, and action-preview states. This is not a conformance certification or a substitute for participant testing. Screenshots and the detailed HTML report are generated locally in `test-results/` and `playwright-report/`.

## Startup and production

An independent production server on an ephemeral loopback port served the built HTML, JavaScript bundle, health endpoint, and idle session without opening a controlled browser. It was then closed cleanly. The macOS launcher's non-mutating `--check` recognized the existing development instance. Starting another production process on the occupied port failed clearly without stopping the running instance. Shell and launcher JavaScript syntax checks passed.

`Launch Nerve.command` checks the Node version, reuses an existing Nerve interface, refuses unknown port occupants, reports setup/build/startup failures, and only shuts down its own child process. The included GitHub Actions workflow has been configured but was not run on GitHub during this local verification.

## Deliberate boundaries

- Browser-only computer control, not unrestricted desktop or operating-system control.
- Exact screenshot matching may reject approvals on animated or otherwise changing pages. It is intentionally conservative.
- External browsing is restricted to one approved public HTTPS origin; cross-origin assets and authentication flows may not work.
- A general external task's final model report is not an independent success check. Inspect its resulting screen.
- No mind-reading, clinical accuracy, universal-accessibility, or reduced-fatigue claim has been validated.

See [evaluation protocol](EVALUATION.md) for how to collect participant evidence without confusing it with synthetic tests.
