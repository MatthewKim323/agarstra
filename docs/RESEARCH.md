# Research and design rationale

Reviewed 8 September 2026. Primary sources are linked next to the claims they support. This is an engineering prototype, not a clinical intervention, brain interface, or validated gaze tracker.

## Product hypothesis

An intentional, low-bandwidth signal can select a useful task when combined with visible computer context. The goal is less physical input for a successful task, without losing control over what happens. Nerve does not infer unobservable thoughts, diagnose disability, or infer emotion from facial movements.

The research hypothesis is not that webcam control is new. It is that context-aware task choices plus explicit approval can reduce interaction effort relative to traversing every underlying control. That advantage has to be measured with the people and tasks the product is intended to serve.

## What the existing work establishes

### Camera control has substantial prior art

Google's Project Gameface maps head movement and configurable facial gestures to computer input. Its Android work exposes expression thresholds and cursor-speed customization, and was developed with disability-community collaborators. Nerve's webcam input is therefore an implementation building block, not a novelty claim. Individual configuration and participant involvement matter more than the number of gestures supported. [Google Developers: Project Gameface](https://developers.googleblog.com/project-gameface-launches-on-android/)

### Face landmarks are not screen gaze

MediaPipe Face Landmarker provides face landmarks, expression blendshapes, and optional transformation matrices. A separate, person-and-setup-specific mapping is needed to estimate a screen location. Its JavaScript detection methods are synchronous, so inference must be throttled or moved off the UI thread to preserve responsive controls. A face-detection threshold is not a calibrated probability that the intended target is correct. [Google AI Edge: Face Landmarker for Web](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js)

Nerve uses camera features as experimental coarse positioning evidence. Calibration estimates the relation between observable features and screen targets. Moving the camera, changing posture, resizing the viewport, glasses glare, or occlusion can invalidate that relation. Those are conditions to test, not conditions the prototype is known to handle reliably.

### Calibration can help without making webcams precise instruments

WebGazer demonstrated browser-based webcam gaze estimation using regression and user interactions for calibration. The paper also describes sensitivity to environments and human features. Its reported experimental results are results for that system and population, not performance numbers for Nerve. Nerve must report its own held-out target error and task outcomes rather than borrowing those numbers. [Papoutsaki et al., IJCAI 2016](https://cs.brown.edu/people/apapouts/papers/ijcai2016webgazer.pdf)

### Looking is not authorization

Jacob's gaze-interaction research describes the Midas Touch problem: people look around to perceive an interface, so observing a fixation is not generally enough to distinguish an intended command from ordinary viewing. This motivates separate stages for candidate selection and action approval, plus a pause control that stops selection. Dwell alone is not a general solution. [Jacob, ACM TOIS 1991](https://www.cs.tufts.edu/~jacob/papers/tois.pdf)

### One-switch scanning is a useful baseline

Apple's Switch Control supports one or more switches and scanning-based item selection. A context-aware interface should be compared against straightforward scanning, not only against a mouse operated under artificial constraints. Switch timing and choice order are part of the experience, not incidental implementation details. [Apple: Switch Control](https://support.apple.com/en-us/119835)

## Accessibility decisions

Nerve aims for large, labeled native controls, visible focus, keyboard operation, reduced-motion support, and non-color-only status. WCAG 2.2 covers keyboard access, focus, and concurrent input. Passing automated checks does not establish conformance or usability for every access need. [WCAG 2.2](https://www.w3.org/TR/WCAG22/)

WCAG 2.2's minimum target-size criterion generally requires 24 by 24 CSS pixels, with specific exceptions. Larger targets are preferable for important selection and safety actions; the enhanced target-size criterion uses 44 by 44 CSS pixels. Nerve's design target for primary controls is at least 44 pixels high. [W3C: Target Size Minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [WCAG: Target Size Enhanced](https://www.w3.org/TR/WCAG22/#target-size-enhanced)

No particular gesture should be assumed available or comfortable. The shipped camera gesture may not work for an individual. Pointer and keyboard/switch modes remain alternatives. A successful lab trial with a developer is not evidence of accessibility benefit for someone with a different movement profile.

## Computer-use boundary

OpenAI recommends an isolated browser or VM, allowlisted sites/actions, treating screen content as untrusted, confirmation for consequential actions, bounded runs, cancellation, and verification of the actual outcome. These must be enforced by the application, not left solely to the model prompt. [Official computer-use safety guidance](https://developers.openai.com/api/docs/guides/tools-computer-use#run-safely)

Practice mode and Astra mode must be distinguishable. Practice can prove the input-to-approval-to-browser path using deterministic actions; it cannot prove model understanding or general computer-use ability. A live model run is a separate integration evaluation requiring explicit screen-sharing consent and account access.

## What would justify a stronger claim

See [EVALUATION.md](EVALUATION.md). Useful evidence would be repeated, independently checked task completions with fewer intentional activations or less reported effort, without increased unwanted actions. Camera validation, accessible-control testing, live model reliability, and participant outcomes are separate measurements.

Do not market this release as mind reading, medical-grade eye tracking, universal disability support, a replacement for established assistive technology, or a demonstrated improvement over existing products. The differentiator is the implementation and an evaluation hypothesis, not a clinical or scientific conclusion.
