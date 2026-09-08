# Your first complete task

Nerve is the app; `agarstra` is the repository. Start with practice mode, then try the same workflow with Astra. Camera input is optional in either mode.

## 1. Run it locally

Install Node.js 22.12 or newer; Node 24 is recommended. Use a current Chromium-based browser.

```sh
git clone https://github.com/MatthewKim323/agarstra.git
cd agarstra
npm ci
npm run setup
npm run dev
```

With GitHub CLI, `gh repo clone MatthewKim323/agarstra` can replace the first command. If you already have the project, change into that directory instead of cloning it again.

Keep the terminal running and open [http://127.0.0.1:4317](http://127.0.0.1:4317). Setup downloads isolated Chromium and local vision assets; it does not request camera access. On Linux, Playwright may also need system dependencies: `npx playwright install --with-deps chromium`.

### Updating an existing checkout

The gaze upgrade adds a pretrained local model and runtime dependencies. Stop the old development server with Ctrl+C. From your existing project directory:

```sh
git pull --ff-only
npm ci
npm run setup
npm run dev
```

Reload the app after that one restart. Do not open a second server on the same ports. If `git pull --ff-only` reports local changes or divergent history, preserve your changes and resolve that separately; do not reset or force-pull them away. Setup downloads and checks the Peekr model and installs local runtimes, but never opens the camera.

## 2. Save a draft with minimal input

1. Choose **Start practice**. The workspace shows a real isolated browser with synthetic email and notes, not your personal accounts.
2. Choose **Draft a reply**, then **Confirm intent**.
3. Read the proposed action, then choose **Approve action**. Approval applies only to that exact preview.
4. Repeat the approval step as Nerve opens the composer, writes the reply, and saves it. The final message confirms the saved draft was independently checked. Nothing is sent.

Try **Save a note** or **Archive message** next. **Settings > Reset workspace** discards practice data and starts over. These practice tasks use deterministic recipes, not live model reasoning.

Clicking inside the screenshot only indicates a region of attention. It does not click the remote browser. **Read this screen** refreshes the screenshot and suggestions without executing an action.

## 3. Do it with one switch

Choose **Single switch**, or connect an accessibility switch configured to emit Space. The outline moves between available controls. Press Space when the control you want is highlighted.

The same input handles intent selection, confirmation, action approval, cancellation, and dialog controls. Holding Space does not repeatedly activate controls. Adjust scanning speed in **Settings**. Tab and Enter also work. Custom free-text instructions are optional and require keyboard input; the suggested-intent workflow does not.

## 4. Add webcam input

Camera setup does not scan controls automatically. If you use a single switch, choose **Enable switch scanning** (it is initially focused, so Space can enable it). The moving button outline belongs to this optional scanner, not your gaze.

1. Choose **Camera**, then **Enable camera**. Allow camera access in your browser.
2. Choose **Calibrate gaze**. Read the instructions at your own pace. Nothing is being recorded yet.
3. Choose **Start gaze calibration** when comfortable. Look directly at the center of the small green dot, not the instructions or camera. Keep looking until it moves, then follow it. No clicks or gestures are needed. Blink naturally.
4. Follow nine training points and five independent check points. Allow about one minute. A ring fills only while a steady eye signal is being collected; a pause is not a request to click. If it keeps waiting for camera frames, close other camera/video applications.
5. Leave **Eyes only** selected. Enable **Remember me on this device** to save the checked calibration and intent learning.
6. Choose **Check gaze controls**. Follow the four-area check for the large controls. A failed check keeps commands disabled.
7. When the workspace fills the screen, look at the area you want help with. A steady coarse gaze requests suggestions; it does not click the remote browser or teach an intent. If no steady area is found after eight seconds, Nerve returns to generic choices without reusing an old gaze point. The large **Stop** area remains available.
8. When the large choices return, look at the center until ready, then hold on the left choice to select it or the right choice to see another. Return to the center between selections, confirmations, and approvals. Accepted goals and an explicit **None of these** teach Nerve automatically. No manual intent lessons or facial gesture are required.

On your next visit, **Check saved calibration** uses five independent check points and skips the training points if your camera and viewport still match. Use the same browser and address/port. To finish, look at **Stop**, then choose **Finish session**. Saved calibration and learning remain on this device. See the [complete eyes-only flow](EYES_ONLY.md).

If you prefer a facial signal, select **Gaze + gesture**, choose a comfortable movement, and use **Calibrate gesture** after passing gaze setup.

### If the gaze check does not pass

If the dot stays in one place, look at **Usable eye observations** and **Accepted at this point**. A nonzero rate means fresh eye-model observations are arriving, not that screen-gaze accuracy has been established. The accepted count increases only while the signal is steady. A zero rate means no usable observations are arriving right now. Before calibration, check the nearby status, inference duration, and capture-delay readout to distinguish missing tracking from slow processing. The collector supports stable slower inputs without restarting between repeated UI polls. Actual tracking loss and stale new captures still pause it.

Both thresholds must pass: average error at most **0.150** and 95th-percentile error at most **0.255**, measured in normalized viewport distance. These are unchanged experimental large-control thresholds, not accuracy percentages. An acceptable average can coexist with a failing worst-end error. Gaze actions stay disabled when either limit fails.

The result now shows every checked position. Numbered circles are the dots you looked at; hollow circles are the average estimates. A long connecting line indicates consistent offset. The **Jitter** column reports how much estimates scattered around their average. That distinction helps separate one poorly estimated screen region from unstable tracking.

For one retry, use soft front lighting, reduce reflections on glasses, and keep your usual comfortable posture. Look at the dot throughout recording. A retry collects fresh training and independent check observations. Do not keep grinding through failed calibrations or lower the limits to make the demo pass. **Back to workspace**, then **Single switch**, is the reliable alternative.

If you want help diagnosing the result, choose **Download numeric diagnostics**. This opt-in local JSON file includes per-point errors, collection counts, viewport dimensions, training-only model-selection summaries, and aggregate camera timing information. It excludes video, images, landmarks, raw eye features, and fitted model weights. Nothing is automatically uploaded; review the file before sharing it.

Recalibrate after moving the camera, changing posture, or resizing the viewport. Ordinary blinking never clicks. Leaving camera mode stops capture and clears current readiness; saved profiles remain available for a fresh check. **Cancel calibration** and **Emergency stop** remain available, including through switch scanning; Escape stops globally.

### What is actually running

A pretrained **Peekr** eye-image CNN runs locally through ONNX Runtime. Its two learned outputs are combined with eight iris/head measurements and eight eye-box coordinates. Personal calibration compares neural, landmark, and combined feature views with linear/quadratic mappings using whole-target cross-validation on training points only. The five independent check targets are never used to tune or choose that mapping.

Camera frames, eye crops, and landmarks stay local. This is experimental coarse gaze input, not thought reading, medical-grade eye tracking, or a clinically validated accessibility device. The upgraded implementation has not established a real-person accuracy improvement. See the [gaze research and model provenance](GAZE_RESEARCH.md), [third-party notices](../THIRD_PARTY_NOTICES.md), and [evaluation protocol](EVALUATION.md).

## 5. Connect Astra

A server-side API key with access to `gpt-6-astra` is required. This uses the API and can incur charges.

1. Stop the development server with Ctrl+C.
2. Copy `.env.example` to `.env`, open `.env` in your editor, and set `OPENAI_API_KEY` to your key. An existing server environment variable also works and takes precedence. Never put a key in client code, screenshots, or git; `.env` is ignored.
3. Run `npm run dev` again and reload the app.
4. Choose **Connect Astra**. Leave **Starting page** blank to keep using the synthetic local workspace.
5. Read and enable the screenshot-sharing consent, then choose **Start Astra session**.
6. Choose **Read this screen** for live model-generated suggestions. Select an intent, confirm it, and review each **Approve action** preview until the task completes.

Astra receives the isolated browser screenshots, task content, and an optional coarse attention point from pointer or calibrated gaze input. If you configure the optional private `.nerve/personal-context.json`, its supplied background and preferences also go to Astra when generating suggestions. That background is not a learned preference, a current intention, or permission to act. It is separate from the local ranker, which learns from your explicitly accepted choices. See [personal context setup and sharing](PERSONAL_CONTEXT.md). Astra does not receive webcam video, eye crops, landmarks, or calibration data. Practice mode needs no key. If your account lacks Astra access, Nerve shows an error instead of silently switching models.

External starting pages must use HTTPS on the default port and public addresses. Only the approved origin is allowed. Cross-origin sign-in, third-party assets, downloads, new tabs, and WebSockets may be blocked. Start with synthetic data. The app controls its isolated browser, not your host desktop or personal browser profile.

## Stop, resume, and check the result

**Emergency stop** is always available in the workspace and setup dialogs. Escape also stops globally, including while typing. Hiding the page stops the task too.

Stop invalidates pending approvals and prevents further queued actions, but cannot undo an action already sent to the browser. Choose **Resume**, then **Read this screen** to refresh the last captured image. Resume does not restart the stopped task.

Practice outcomes are independently checked against the local app state. On external pages, a completion report from Astra is not proof that every intended outcome occurred. Check the resulting screen yourself.

## Demo and verification

For the hackathon, show a real switch-only draft first, then a live Astra task in the same synthetic workspace. Explain which mode is running. Show the exact action preview and stop behavior; add camera input only after a successful real-person calibration.

```sh
npm run check
```

This runs unit tests, a production build, browser tests, and a dependency audit. Browser tests share the single active local session: do not use the app while they run. For a built local app, run `npm run build` followed by `npm start` and open [http://127.0.0.1:4318](http://127.0.0.1:4318).

Keep both servers on localhost. Do not expose them with a tunnel or public host. See the [demo guide](DEMO.md), [recorded verification](VERIFICATION.md), [safety boundaries](SAFETY.md), and [troubleshooting](../README.md#troubleshooting).
