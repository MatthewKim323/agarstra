# Intent learning verification

The intent learner predicts which available goal fits the current person and context. It learns from explicit choices and can update its live guess from brief attention evidence. The north star is earlier anticipation with less explanation and correction. The checks here establish software behavior and synthetic learning behavior, not that Nerve can read thoughts or predict a person's intent at a known accuracy.

## Try it

1. Run `npm run dev`, open `http://127.0.0.1:4317`, and choose **Start practice**.
2. Open **Intent learning** below the task choices. The feature works without a camera or an API key.
3. Choose **Teach without running**, select the goal you would want on this screen, then **Save example**. Use **None of these / just reading** when there is no appropriate task. These controls make no browser action or provider request.
4. Use **Check without learning** for an answer that should be measured without updating model parameters. The earlier prediction is revealed after you label it.
5. Close the dialog to see the current guess alongside the fixed task choices. Confirming a normal task provides one further label after the bridge accepts it. Action approval remains a separate step.
6. Turn on **Remember on this device** to keep the learned weights and counts across reloads. Without this option the model is session-only. Turning it off removes the saved model; **Forget learned intent** clears weights and measurements. **Export intent measurements** downloads aggregate statistics only.

Practice and Astra maintain separate models and measurements. A practice result does not establish that the model will understand arbitrary external websites. Repeating the same choice on the same screen is useful for checking adaptation, but not for proving generalization.

## What is implemented

- A 512-dimensional, signed feature-hashed residual ranker with canonical task families, candidate wording, risk, coarse page category, input mode, coarse attention region at exposure, and the previous explicitly learned task family. This is a lexical and structured representation, not a neural semantic embedding.
- A bounded online update after confirmed or deliberately taught choices. The persistent model contains numeric weights, optimizer accumulators, and aggregate counters. It contains no raw task text, URLs, camera frames, or gaze traces. Model weights are still personal data.
- An explicit none outcome, so a closed suggestion set need not force a task choice. Submitting a custom task through **Something else** labels that offered set as missing the chosen task; opening or cancelling the dialog does not.
- Time-based attention accumulation from current candidate cards. Fresh gaze or moving-pointer samples can temporarily shift the guess; static cursor position, scanning highlights, application-generated actions, and stale observations are not feedback labels.
- Immutable, single-use decision snapshots. Evaluation uses the context prediction made before selection, excluding the later live-attention contribution. Teaching updates after scoring; a check scores without training.
- State binding: suggestions include the fresh state they describe, task selection supplies its expected revision, and late responses after Stop/session replacement are discarded. State polling cannot overtake a pending intent response and erase its learning label.
- Stable candidate positions, keyboard and switch access to all teaching controls, and explicit pause, remember, forget, and export controls.

## Repeatable synthetic experiment

Run:

```sh
npm run evaluate:intent
```

The experiment uses seed `1592598566`, a scripted oracle, and new decision IDs with seeded candidate wording/order variation. The model sees 120 online training decisions across mail, notes, and blank contexts; 60 subsequent decisions are scored without changing learning parameters. A further 80 online decisions change the dominant preference in the notes context. Both methods see the same candidate set and the same reserved 0.15 none prior. No real user, camera, provider, or persisted model is used. No hyperparameter search was performed to obtain these results.

| Phase                                                    | Personalized top choice matches | Original baseline matches | Personalized mean Brier | Personalized mean log loss |
| -------------------------------------------------------- | ------------------------------- | ------------------------- | ----------------------- | -------------------------- |
| 120 online training decisions, scored before each update | 110 / 120                       | 38 / 120                  | 0.2304                  | 0.5413                     |
| 60 check decisions, parameters unchanged                 | 53 / 60                         | 19 / 60                   | 0.2611                  | 0.5883                     |
| First 20 decisions after preference change               | 8 / 20                          | 15 / 20                   | See JSON output         | See JSON output            |
| Last 20 decisions after preference change                | 18 / 20                         | 18 / 20                   | See JSON output         | See JSON output            |
| Entire 80-decision preference-change period              | 63 / 80                         | 70 / 80                   | See JSON output         | See JSON output            |

On the 60 check decisions, the none outcome was the scripted label 18 times. The model predicted none 20 times, with 18 correct and two false positives. The oracle supplies a simple context cue for none; real missing goals may be substantially harder to detect.

The original baseline outperformed personalization across the complete preference-change period. The learner recovered in the later decisions, but its prior habit initially hurt. This is a measured limitation, not a reason to discard the baseline comparison. It motivates collecting changing preferences and unexpected goals during actual use.

Top-choice matches in this table use the highest internal score even when the separate ambiguity gate withholds a displayed guess. These numbers must not be described as confidence, action accuracy, or demonstrated improvement for people. Brier and log loss describe the scored distribution; neither by itself proves probability calibration. The script also reports context groups and the distinction between selected suggestions and abstention.

## Automated verification

Verification on 8 September 2026: **505 unit tests passed across 26 files, the complete 68-test Chromium browser suite passed, and the production TypeScript/Vite build passed.** The intent-specific browser cases account for 15 of those browser tests. Final review added a separate manual Stop regression and portable browser screenshot paths; the affected browser tests were rerun. See [the release verification record](VERIFICATION.md) for the final run. No new runtime dependency was added.

Run `npm test`, `npm run build`, and `npm run test:e2e`. The new checks cover:

| Area                    | Evidence                                                                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Online learner          | Adaptation, changing IDs, context isolation, none labels, measurement before training, untrained checks, ambiguous predictions, replay/forgery/expiry rejection, bounded updates, strict profile validation, unavailable storage   |
| Attention               | Sample-rate independence, change of target, decaying idle pointer, stale/missing/poor observations, invalid timestamps, finite bounded output                                                                                      |
| Server context          | Fresh state in candidate responses, stale revision rejection before planning, Stop/reset/session replacement, response-copy isolation, independent action approval                                                                 |
| Browser behavior        | Teaching never calls the bridge or camera; preview/back/cancel do not teach; accepted confirmations teach once; rejected and late responses do not teach; a poll arriving before a successful confirmation does not lose its label |
| Persistence and privacy | Session-only default, opt-in reload, forgetting, removing saved learning despite failed storage writes, exported aggregate statistics without task content or weights                                                              |
| Input and accessibility | Fixed task order under pointer attention, switch-only teaching and checks, unique scan IDs after dynamic controls appear, automated accessibility checks in setup, trial, and result states                                        |

The new browser tests intercept every `/api` request and use a synthetic bridge. They do not operate a person's real browser account or camera. The full existing suite separately exercises real isolated-browser practice tasks, approval, cancellation, and synthetic-camera integration. Automated accessibility checks do not replace testing with people who use assistive input devices.

## Measuring progress toward anticipation

Start with the separate confirmed-goal, teaching, and check rows. Compare the personal model with the original baseline on the same decisions. Inspect how often none is selected, and how often uncertainty causes the model to withhold a guess. Use later sessions and unfamiliar screens rather than counting neighboring camera frames as independent examples.

The next human evaluation should measure lead time before an explicit choice, task completion, corrections, unnecessary suggestions while reading, recovery after a change of mind, and deliberate inputs per completed task. Counterbalance baseline and personalized sessions. Keep evaluation answers out of training and threshold selection. The detailed collection protocol, source evidence, and alternatives are in [INTENT_RESEARCH.md](INTENT_RESEARCH.md).

No human intent performance has been collected or established by this implementation session.
