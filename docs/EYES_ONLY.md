# Eyes-only Nerve

The daily loop is a saved gaze setup, large choices, deliberate confirmation, and learning from ordinary accepted goals. Manual intent lessons are optional diagnostics, not an onboarding requirement.

## First visit

1. Launch Nerve. On macOS, open `Launch Nerve.command` from the checkout. The first launch installs local assets and builds the app. Alternatively use the commands in [Quickstart](QUICKSTART.md).
2. Open **Camera**, enable the camera, and leave **Eyes only** selected. Enable **Remember me on this device** to retain calibration and intent learning across visits.
3. Follow the gaze dots once. Nine positions train the screen mapping; five separate positions check it. The existing error limits still apply.
4. Choose **Check gaze controls**. The large-control surface checks its actual left, right, center, and Stop areas. These checks only measure the frozen model; they never repair it using the answers.
5. Look at the area you want to work on in the full-size workspace. A stable coarse fixation requests suggestions for that area without running an action. This attention view does not teach an intent label.
6. Look at the center until ready. Hold on the left choice to select it, or the right choice to see another goal. The displayed goal stays put while you look.
7. Look back at the center, then hold **Confirm intent**. The accepted goal teaches Nerve automatically. Read each exact action preview and use a new center-to-approval hold to authorize it. Long previews use **More action details** before approval becomes available.

No mouth opening, eyebrow movement, deliberate blinking, or separate intent-training exercise is required. The vision model still needs a visible face and both eyes in the webcam image. An eyes-only interaction does not currently support an arbitrary tightly cropped image of the eyes.

## Returning and finishing

Open the same browser and the same address/port. After camera permission, a compatible saved calibration offers a shorter independent recheck instead of repeating its training points. A changed camera, capture resolution, viewport, zoom, or model pipeline prevents silently using the old mapping. Passing yesterday does not mark today's camera as ready.

**Stop** is always a separate large gaze region. After stopping, choose **Finish session** to stop capture and return to pointer input. Enabled local saving retains both the checked gaze model and learned intent parameters. There is no last-minute training export or save ceremony. Unchecking remember removes the corresponding saved data; browser storage failures are reported.

The normal approval flow learns accepted, current intent confirmations. Explicitly choosing **None of these** also teaches that the offered goals do not fit, then returns to workspace attention. Browsing, looking, Stop, and previewing a goal do not teach a preference. The learner ranks a new slate once, including the none option; it does not move choices underneath an ongoing gaze.

## Why large controls

The existing experimental calibration limits are mean normalized error 0.150 and 95th-percentile error 0.255. Those limits cannot establish that small adjacent buttons are usable. Eyes-only mode therefore uses widely separated areas with a neutral center and independently tests those areas before enabling commands.

Every stage change clears activation readiness. Fresh reliable center gaze must last at least 350 ms, followed by a new 1100 ms hold on a command. Stop uses a separate 650 ms hold and remains reachable while commands are waiting for rearming. Duplicate frames cannot accumulate time, and missing or stale input does not count as looking away. Staying on the same position cannot select a goal, confirm it, and approve the replacement action in sequence.

These are engineering gates, not measured human accuracy. If the area check fails, actions stay disabled. Recalibrate or leave camera input; repeated failures need diagnosis rather than relaxed pass thresholds.

## Get it into people's hands

The current pilot is a local app with an isolated browser, distributed as a checkout with the launcher. It is not a hosted multiuser service. Practice tasks run without an API key. Live Astra tasks use a server-side key and explicit screenshot-sharing consent; webcam frames stay local.

Before calling the eye experience ready for a pilot, record one complete real-camera task on the intended laptop: first setup, saved-profile return check, intended goal, separate approvals, Stop, and Finish. Record setup time, failed checks, unavailable tracking, corrections, accidental activations, and verified task outcome. Keep failed attempts in the record. Synthetic browser tests prove control flow, not that the webcam knows where a person is looking.

When a point stalls, inspect usable observations per second and total capture latency. The tracker now reports latency even for rejected results. The fallback path also uses one captured frame for landmarks and eye crops, preventing motion between those two inputs. These fixes do not establish which failure occurred on any particular webcam.

Intent personalization can grow during useful tasks. A screen-to-gaze mapping still needs some evidence from that person and camera position. Eliminating explicit calibration entirely would require a separately evaluated model or implicit ground-truth signal; self-training on its own unverified guesses would reinforce errors.

An optional [private personal context file](PERSONAL_CONTEXT.md) can inform live suggestions before any confirmed examples exist. It contains explicit background and preferences. It is not counted as observed training data or evidence of prediction accuracy.
