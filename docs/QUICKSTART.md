# Your first complete task

Nerve is the app; `intentions` is the repository. Start with practice mode, then try the same workflow with Astra. Camera input is optional in either mode.

## 1. Run it locally

Install Node.js 22.12 or newer; Node 24 is recommended. Use a current Chromium-based browser.

```sh
git clone https://github.com/MatthewKim323/intentions.git
cd intentions
npm ci
npm run setup
npm run dev
```

With GitHub CLI, `gh repo clone MatthewKim323/intentions` can replace the first command. If you already have the project, change into that directory instead of cloning it again.

Keep the terminal running and open [http://127.0.0.1:4317](http://127.0.0.1:4317). Setup downloads isolated Chromium and local vision assets; it does not request camera access. On Linux, Playwright may also need system dependencies: `npx playwright install --with-deps chromium`.

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

1. Choose **Camera**, then **Enable camera**. Allow camera access in your browser.
2. Choose **Calibrate gaze**. Follow nine calibration targets, then five separate validation targets.
3. If validation passes, choose a comfortable gesture: **Mouth open**, **Eyebrow raise**, or **Smile**.
4. Choose **Calibrate gesture**. Follow the resting and active prompts without straining.
5. Choose **Use calibrated input**. Look at a control until it is highlighted, make your gesture to select, then release before selecting again.

Failed validation keeps gaze actions disabled. Improve lighting and camera stability, retry, or use a switch. Recalibrate after moving the camera, changing posture, or resizing the viewport. Ordinary blinking never clicks. Leaving camera mode stops capture; calibration lasts only for the current session.

Camera frames and landmarks stay local. This is experimental coarse gaze input, not thought reading, medical-grade eye tracking, or a clinically validated accessibility device. Real-person calibration and usability still need evaluation.

## 5. Connect Astra

A server-side API key with access to `gpt-6-astra` is required. This uses the API and can incur charges.

1. Stop the development server with Ctrl+C.
2. Copy `.env.example` to `.env`, open `.env` in your editor, and set `OPENAI_API_KEY` to your key. An existing server environment variable also works and takes precedence. Never put a key in client code, screenshots, or git; `.env` is ignored.
3. Run `npm run dev` again and reload the app.
4. Choose **Connect Astra**. Leave **Starting page** blank to keep using the synthetic local workspace.
5. Read and enable the screenshot-sharing consent, then choose **Start Astra session**.
6. Choose **Read this screen** for live model-generated suggestions. Select an intent, confirm it, and review each **Approve action** preview until the task completes.

Astra receives the isolated browser screenshots and task content, not webcam video or calibration data. Practice mode needs no key. If your account lacks Astra access, Nerve shows an error instead of silently switching models.

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
