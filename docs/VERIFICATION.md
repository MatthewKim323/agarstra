# Verification record

Tested 8 September 2026 on macOS, Node.js 24.7.0, Chromium through Playwright 1.63.0. These are implementation checks, not disability-user trials or a general benchmark of model ability.

## Gaze upgrade verification

The final integrated gaze-upgrade gate passed `npm run check` on the same date. The release-scoped unit files were also rerun separately, excluding uncommitted work from another development stream:

| Check                                  | Result                     |
| -------------------------------------- | -------------------------- |
| Release-scoped unit tests              | 265 passed across 14 files |
| Strict TypeScript and production build | Passed                     |
| Real Chromium browser tests            | 29 passed in 2.0 minutes   |
| Dependency audit                       | 0 reported vulnerabilities |

This gate includes an actual forward pass through the pinned Peekr ONNX network using generated eye images and supplied synthetic landmarks. It checks finite outputs and local-only requests. Separate generated-camera tests load MediaPipe, Peekr, and ONNX WASM in development and in the built production app, then verify stopped media tracks. The generated camera is not a person, and supplied synthetic landmarks do not verify real-camera detection or gaze accuracy.

A separate browser fixture replaces only the sensor adapter inside that test context. The real calibration session and UI complete nine training and five independent check points, reject a stable single-target bias, keep gaze actions disabled, and export the numeric diagnostics without image or raw-feature fields. Ready remains untimed beyond the target timeout. Automated accessibility checks pass on Ready and the rejected-results screen. These are synthetic observations, not a human calibration result.

The real-user result reported before this upgrade was mean error `0.138` and 95th-percentile error `0.295`. The mean passed the `0.150` cutoff; the tail failed the `0.255` cutoff. Those cutoffs remain unchanged. A regression test retains that rejection. We have not measured this person's accuracy after the upgrade.

Training-only whole-target cross-validation, robust fitting, distinct-frame collection, fixation checks, and per-target error diagnostics have automated coverage. They improve the implementation, not the strength of any human-performance claim. Independent check observations never select or fit the model.

Final review added regression tests for raw, unclipped scoring: a synthetic fixture with rare extreme predictions could previously pass after clipping those errors to the viewport. Cross-validation and independent evaluation now score finite raw predictions, while the public control predictor remains screen-bounded. Camera tests also cover cancellation during both model-loading stages, bounded initialization, failed teardown, stale-session inference, and exclusive worker ownership during overlapping messages.

## Stuck-dot follow-up

The initial upgrade's tests missed a timing boundary: requiring five observations inside a 650 ms history made stable inputs slower than about 6.15 frames per second unable to collect any samples. A second defect treated repeated UI polls of one already-delivered result as fresh evidence of tracking loss once its original capture aged past 350 ms.

The follow-up uses a seven-observation history bounded by the existing capture-gap checks, and distinguishes a repeated poll from a newly delivered frame. The UI now admits observations into active gaze calibration immediately on arrival, retaining their original capture timestamps. This avoids adding up to 70 ms of UI polling delay to an otherwise usable slow inference. New captures still require age at most 350 ms; duplicate observations never add samples, extend their receipt time, or advance progress. Actual stalls, lost tracking, and sudden eye movements still clear the current collection. Mean and tail accuracy limits remain unchanged.

Regression fixtures that failed before the fix now advance the first target at 165, 200, 300, and 333 ms frame intervals. A full synthetic fourteen-target session also completes with 300 ms frame spacing, 200 ms capture-to-delivery delay, and 70 ms UI polling. Targeted calibration/session tests: 57 passed. This establishes a collector fix, not measured improvement on the user's camera.

Camera setup now makes switch scanning explicit opt-in. Its automatic button outline is not a gaze estimate. Local-only rate, capture-delay, and accepted-sample readouts distinguish incoming eye-model observations from successful screen calibration. Four browser fixtures replace only the sensor and verify first-dot advancement at 200 to 333 ms frame intervals with up to 330 ms capture delay, then pause deliveries and verify that the displayed usable rate and accepted count reset. A fifth fixture delivers high-quality but 400 ms-old captures every 200 ms; both counters stay zero and the dot cannot advance. These fixtures never open a real webcam.

The follow-up release checks passed: 275 release-scoped unit tests across 14 files, strict TypeScript and production build, all 35 release-scoped browser tests, and a dependency audit with zero reported vulnerabilities. GitHub's clean Ubuntu runner also passed [run 34289688700](https://github.com/MatthewKim323/agarstra/actions/runs/34289688700), including the final compact layout. Browser checks include native Space opt-in, no automatic scanning during calibration, stopped synthetic camera tracks, and accessibility checks with the camera footer no longer covering other controls. A CI synchronization regression ensures the emergency-stop key event is dispatched while that control is actually highlighted, rather than after layout inspection has consumed another scanner turn. Separate uncommitted intent-learning work was excluded from this release.

## Eyes-only and personal intent integration

The combined local gate passed 505 unit tests across 26 files, strict TypeScript and a production build, 68 Chromium browser tests in 3.2 minutes, and a dependency audit with zero reported vulnerabilities. The browser suite used a separate loopback server and session, leaving the running user workspace intact. Sensor fixtures and generated-camera tests do not establish real-person gaze accuracy.

Final review then made screenshot artifact paths portable to Linux and unified manual and gaze Stop behind the same terminal latch. A new still-mounted-view regression verifies that repeated manual Stop blocks later fixation and timeout callbacks. All 29 affected browser cases passed again in 53.2 seconds, and the production build passed again. The complete suite now contains 69 cases; the recorded local evidence is the 68-case full run plus the affected-case rerun, not a claimed 69-case full run.

The integration adds frozen saved-calibration rechecks, an independent check of the actual large control regions, center-to-command rearming, and learning from explicitly accepted goals or rejection of the offered goals. A separate full-size screenshot view gathers coarse attention without clicking the browser or creating a training label. Returning from that view requires fresh rearming before any goal or approval can activate.

Brief tracking interruptions may preserve accepted calibration samples for at most 700 ms, but require another stable fixation before collection resumes. Lost time and renewed settling time never count as collected evidence. Longer loss, changed eye geometry, and target changes discard the retained samples. New captures still must arrive within 350 ms. Boundary regressions prime nearly complete holds at three frames per second: distinct 349/350 ms-old captures may complete them, while distinct 351 ms-old captures cannot fire an action, advance a check, preserve readiness, or extend its deadline.

The optional server-side personal-context file supplies explicit background, not training examples. Vite now denies the private `.nerve` directory in addition to its existing secret-file rules. Twenty-four policy regressions pass, including 11 that failed before the fix. HEAD requests against the running development server returned 403 for both the root-relative private-context path and its `/@fs` raw-query form; the app root returned 200. No private response bodies were requested. This check is separate from gitignore and production static serving.

The [intent experiment](INTENT_VERIFICATION.md) was reproduced independently: 53 of 60 frozen synthetic check decisions matched the scripted label, compared with 19 of 60 for the original ranking. After a scripted preference change, personalization initially hurt and scored 63 of 80 compared with 70 of 80 for the baseline. These are small synthetic mechanism checks, not human prediction accuracy or evidence that the system reads thoughts.

## Initial release gate

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

A repeat during eyes-only integration also passed: archive used three provider responses, two approval batches, and two primitive actions in 14.246 seconds; the saved reply used four responses, three batches, and five actions in 10.862 seconds. All eight requests, including the separate suggestion request, returned HTTP 200. The archive timing includes the suggestion check. Both outcomes were independently checked against synthetic lab state. The harness explicitly disables optional private personal context, uses no personal account or webcam, and never sends the draft. This is a live provider integration check, not an eyes-only human trial.

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

`Launch Nerve.command` checks the Node version, reuses an existing Nerve interface, refuses unknown port occupants, reports setup/build/startup failures, and only shuts down its own child process. The initial-release workflow subsequently passed on GitHub's Ubuntu runner: [run 34281469112](https://github.com/MatthewKim323/agarstra/actions/runs/34281469112).

## Deliberate boundaries

- Browser-only computer control, not unrestricted desktop or operating-system control.
- Exact screenshot matching may reject approvals on animated or otherwise changing pages. It is intentionally conservative.
- External browsing is restricted to one approved public HTTPS origin; cross-origin assets and authentication flows may not work.
- A general external task's final model report is not an independent success check. Inspect its resulting screen.
- No mind-reading, clinical accuracy, universal-accessibility, or reduced-fatigue claim has been validated.

See [evaluation protocol](EVALUATION.md) for how to collect participant evidence without confusing it with synthetic tests.
