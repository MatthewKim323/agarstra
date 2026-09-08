# Evaluation and release verification

The evaluation question is: can contextual task selection reduce intentional input while preserving user control and actual task success?

The product north star is a "reads my mind" experience, not literal thought decoding. Judge progress by how little a person must explain or physically do to reach the right completed task. Eye-tracker accuracy alone does not establish that outcome; intent misses, clarification effort, corrections, and unwanted actions count against it.

## Keep evidence categories separate

| Evidence                                                 | What it establishes                                                | What it does not establish                             |
| -------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| Unit test with generated landmarks                       | Mathematical behavior and edge-case handling                       | Real webcam accuracy or comfort                        |
| Local pretrained-model loading or tensor-contract test   | Model asset availability, input layout, and finite output behavior | Correct gaze for a person or an accuracy improvement   |
| Browser test using pointer/keyboard and practice actions | UI, approval, and actual controlled-browser integration            | Astra reasoning, gaze performance, or clinical benefit |
| Camera trial on real hardware                            | Behavior for that person, setup, and session                       | Reliability across people or environments              |
| Live API run                                             | Integration with that configured model and task                    | General capability or superiority to another model     |
| Consented participant study                              | Outcomes for documented participants and conditions                | Universal accessibility or medical effectiveness       |

Synthetic scores, seeded rankings, practice completions, and generated sensor inputs must be labeled as such. Do not combine their success counts with human camera trials or live model runs.

## Automated commands

From the project root:

```sh
npm test
npm run build
npm run test:e2e
```

The Playwright suite uses a real browser without requesting a real webcam, account login, or API key. It runs serially because the local controller has one active browser session. Failure screenshots and traces are captured in `test-results/`. The test suite does not measure human reaction time or model latency.

One test launches Chromium with its generated fake-camera device and loads the local vision assets and runtimes. The upgraded camera path initializes MediaPipe and the pretrained Peekr ONNX model. Tests cover startup, local asset loading, no external requests during that flow, media-track cleanup, restart, and single-switch Emergency stop during calibration. A generated test pattern is not a human face and cannot validate gaze accuracy or gesture recognition. A separate delayed-permission fixture verifies that closing camera setup stops a stream granted afterward. See [recorded verification](VERIFICATION.md) for what a particular completed run actually verified.

The accessibility tests run axe against the entry, Settings, Camera, and Astra setup dialogs, the running synthetic camera, the active workspace, and its approval controls. Automated rule coverage is limited; a zero-violation result is not a WCAG conformance certification or substitute for keyboard/switch and participant testing.

## Practice task benchmark

Each task begins from a fresh practice workspace. A completion is valid only when the resulting workspace confirms the requested change.

| Task                 | Required result                                                                          | Failure examples                                                              |
| -------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Draft a reply        | Reply editor or saved local draft contains the intended text; nothing is sent externally | Merely selecting Reply; claiming success without text; transmitting a message |
| Save a note          | New local note exists with expected content                                              | Text typed into the wrong control; note never saved                           |
| Archive message      | Target message enters the practice archive                                               | Wrong message changed; irreversible deletion                                  |
| Cancel proposed task | No browser action occurs from that proposal                                              | Approval still accepted after cancellation                                    |
| Emergency stop       | Outstanding proposal/work is invalidated; state visibly reports stop                     | Old work resumes without fresh authorization                                  |

Practice plans may be deterministic. That makes them useful integration tests, not an evaluation of open-ended model understanding.

## Human interaction benchmark protocol

1. Explain privacy and stop controls. Use fictional messages and notes. Record voluntary input preference rather than assuming camera access.
2. Let the participant configure a comfortable scan/dwell rate and gesture, where supported. Record the configuration.
3. If testing camera, calibrate and then validate on separately collected check observations. Distinguish unseen positions from a repeated center check. Do not count calibration fitting error as held-out performance.
4. Compare contextual task selection with a straightforward fixed-order single-switch scan using the same task set, resources, confirmation requirements, and time budget.
5. Counterbalance condition order. Give equivalent practice. Record failures, assistance, and abandoned tasks, not just completions.
6. Repeat tasks with altered layout or message content. Stop at participant request or discomfort.
7. Report per-person results before aggregates. Small exploratory samples are not evidence of general superiority.

This protocol is a proposed study design, not a claim that a participant study has occurred.

## Upgraded gaze calibration protocol

The current pipeline is appearance-based, not only landmark regression. The pretrained local Peekr CNN contributes two outputs. Eight iris/head features and eight eye-box coordinates produce an 18-feature observation. The model source, preprocessing contract, alternatives, and evidence limits are documented in [gaze research](GAZE_RESEARCH.md); attribution is preserved in [third-party notices](../THIRD_PARTY_NOTICES.md).

1. Open **Camera > Enable camera > Calibrate gaze**. Explain what the person will look at before choosing **Start gaze calibration**. The Ready screen is untimed and collects no calibration samples.
2. Keep a comfortable, repeatable setup. Record browser viewport, camera placement, lighting, glasses, and the person's chosen input without collecting identifying video by default.
3. Follow nine training points. Collection requires fresh, distinct frames and a steady temporal eye/head signal. A target waits through settling, rejects motion excursions, and fails visibly after its bounded timeout. Record rejected or unavailable tracking rather than silently dropping the whole attempted calibration from evaluation.
4. Fit robust, target-balanced calibration only on those training observations. Whole-target cross-validation chooses neural-only, landmark-only, neural-plus-eye-position, or fused views and a linear/quadratic mapping. All samples from a held-out training location stay outside that cross-validation fold, including feature normalization.
5. Freeze the selected model, then collect five independent check targets. Four locations are new off-grid positions; one is a fresh center check. None of these observations is used to fit, choose, or repair the model. Do not describe the center as an unseen location.
6. Apply both unchanged limits: average error at most 0.150 and 95th-percentile error at most 0.255 in normalized viewport distance. Report failure when either limit fails. Do not lower the thresholds, discard bad check targets, or reuse their labels for model selection to turn a run into a pass.
7. Inspect the per-target map and table. Average offset and RMS jitter answer different questions. Report failures in a particular screen region separately from broad frame-to-frame variation. A pass allows experimental large-control testing, not a claim of pixel-precise or clinical accuracy.
8. If the person chooses **Download numeric diagnostics**, review the resulting local JSON before sharing it. It includes viewport dimensions, collection counts, fit-family/feature-view summaries, and target-level check metrics. It does not include video, images, landmarks, raw eye features, or fitted weights. No automatic upload occurs.

A retry starts fresh training and independently collected check observations. Report the total attempts and time, not just the best successful attempt. After a successful check, separately measure intended-control selections, missed controls, accidental selections, gesture effort, and recovery. Repeat after normal posture changes and over time to detect drift. The new model and automated tests do **not** yet establish an improvement in human gaze accuracy.

## Metrics and definitions

| Metric                      | Definition                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| Verified task success       | Correct resulting workspace state within the prespecified budget                                         |
| Intentional activations     | Physical switch presses or deliberate confirmations; count corrections and cancels                       |
| Completion time             | Task revealed to verified outcome; report setup/calibration separately                                   |
| Unwanted proposal rate      | Participant reports selected task differed from intended task / all proposals                            |
| Unwanted execution count    | An action executed without intended approval; report absolute count, even if zero                        |
| Recovery effort             | Activations and time required after an incorrect choice                                                  |
| Abstention rate             | Attempts where the system declined to select due to insufficient evidence                                |
| Tracking availability       | Usable observation time / time camera mode was active, with threshold documented                         |
| Held-out target error       | Distance between predicted and instructed target on unused validation targets; report viewport and units |
| Reported effort and control | Participant ratings and comments, using a stated instrument or clearly labeled custom questions          |

Confidence displays are heuristic unless calibrated against independently labeled trials. A posterior over the offered choices cannot establish that the correct intent is among those choices. Include an escape route such as cancel, another task, or direct goal entry.

## Manual release checklist

- [ ] Real webcam permission granted, denied, revoked, and unavailable have understandable outcomes.
- [ ] Camera light turns off when camera input is stopped; no video payload is sent to the bridge or model.
- [ ] Ready instructions wait for explicit start, and the person understands to look at the dot rather than the instructions during collection.
- [ ] Calibration is tested on separately collected check observations, not fit data; the fresh center check is distinguished from the four unseen positions.
- [ ] Both unchanged error limits are enforced; a passing average cannot mask a failed 95th-percentile error.
- [ ] Per-point offset/jitter and optional numeric exports agree with the check results and contain no raw biometric inputs.
- [ ] Missing face, occlusion, lighting change, off-center posture, and window resize cannot silently trigger a command.
- [ ] One sustained gesture produces at most one selection until release/rearm.
- [ ] A full practice task, cancellation, approval, pause, and stop can be completed with the intended switch alone.
- [ ] Keyboard focus remains visible, controls have names, and no dialog traps the person unexpectedly.
- [ ] Layout remains usable at narrow widths, browser zoom, and reduced-motion preference.
- [ ] Screen-sharing consent is explicit before a live model request; key errors do not expose credentials.
- [ ] A live Astra request is tested only with an explicitly configured account and consent, then recorded separately from practice.
- [ ] Unsupported model responses, timeouts, and disconnected bridge fail visibly without executing a guessed action.
- [ ] The model's final message is checked against actual task state.
- [ ] Documentation and demo narration disclose what has and has not been measured.

## Run record template

```text
Date / commit:
Environment / browser / viewport:
Mode: practice | live model
Input: pointer | switch | real camera | synthetic fixture
Model ID and reasoning setting (live only):
Task and ground-truth success check:
Preparation/calibration time:
Task completion time:
Intentional activations / corrections / cancels:
Verified outcome:
Unwanted actions:
Observed limitations:
Artifacts:
```

Fill a run record from actual observations; never use illustrative values as a measured result.

## Initial release verification: September 8, 2026

The following is the original release record, before the pretrained gaze upgrade. These are implementation checks on the development machine, not a participant study or a general capability benchmark. Do not present these original test counts as the upgraded run; consult [VERIFICATION.md](VERIFICATION.md) for subsequent records.

### Browser integration

The final `npm run check` browser stage completed with **26 passed** in **1.4 minutes**, with one Chromium worker and reduced-motion enabled. Desktop screenshots used a 1440 by 1000 viewport; the narrow-layout check used 390 by 844. The camera check also asserts that Emergency stop does not overlap any of the nine training or five held-out marker positions. The same command passed 163 unit tests, TypeScript, the production build, and a dependency audit with zero reported vulnerabilities.

- Draft, note, and archive tasks changed the real isolated browser's state, independently read back through the bridge. Practice planning was deterministic; this did not use Astra.
- A complete draft was selected, confirmed, and approved with synthetic Space key activations after choosing single-switch mode. The test waited for the real scanner to highlight each target. This is an integration check, not a measurement of a person's completion speed or motor effort.
- Cancellation, old-approval rejection, Emergency stop, keyboard Escape, pause/resume, camera permission denial, preferences, audit export, and origin validation passed.
- Additional regressions cover late responses after Stop, offscreen/covered gaze target exclusion, an early first switch signal with repeat protection, and switch access to secondary navigation, exports, consent, and in-dialog Emergency stop. Browser hit-testing checks that highlighted controls are not covered by the fixed footer or calibration overlay.
- The actual locally served vision model and WASM initialized using Chromium's generated camera pattern. No external requests were observed in that flow. Stopping camera ended its tracks. Restarting, entering the actual calibration overlay, and selecting Emergency stop with Space ended the second stream. A separate delayed-permission test confirmed that closing setup also stopped a subsequently granted stream.
- Axe reported zero violations for the tested WCAG A/AA rule sets on the inspected entry, dialogs, running camera, active workspace, and approval state. Screenshot inspection confirmed no narrow-screen overflow and a visible, 44-pixel-or-taller Emergency stop control.

The suite regenerates `test-results/nerve-desktop.png`, `test-results/nerve-mobile.png`, `test-results/nerve-approved-draft.png`, and `test-results/nerve-calibration.png`. These are local run artifacts and are not committed.

### Live Astra integration, synthetic local workspace only

The opt-in [live smoke runner](../tests/server-live-smoke.ts) was run with `gpt-6-astra`, an explicitly configured account, and synthetic mail content. Each task used a fresh isolated browser. The runner approved action batches only while the browser remained at the exact local practice URL and independently checked its resulting state. Seven provider requests returned HTTP 200.

| Task                                | Provider calls | Approved batches | Executed actions |        Elapsed | Independently verified result                     |
| ----------------------------------- | -------------: | ---------------: | ---------------: | -------------: | ------------------------------------------------- |
| Archive selected practice message   |              3 |                2 |                2 | 10.960 seconds | Target ID appeared in the local archive           |
| Save a reply to Alex confirming 3pm |              4 |                3 |                5 | 13.459 seconds | Local draft contained text and the requested time |

Elapsed time includes browser startup, provider requests, programmatic approvals, and outcome verification. It excludes human decision time and camera calibration. These two successful tasks show that the model integration really ran; they do not establish broad reliability, accessibility effectiveness, or superiority over another model. Action batches were automatically approved by this synthetic-only test harness, not by the product's camera interface.

To rerun intentionally with paid API access:

```sh
NERVE_LIVE_TEST=1 npx tsx tests/server-live-smoke.ts
```

Real human-camera calibration, gesture accuracy, participant comfort, assistive-switch hardware, and general external-site task completion have **not** been evaluated by these runs. They remain explicit validation work before making claims in those areas.
