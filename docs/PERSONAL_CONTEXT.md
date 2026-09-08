# Personal context before training

Live candidate generation can use a local `.nerve/personal-context.json` file. The directory is ignored by git. This provides explicit background before the intent learner has observed any confirmations. It does not fine-tune the gaze network, create fake training labels, or authorize actions.

Example shape:

```json
{
  "version": 1,
  "name": "Your preferred name",
  "context": ["I build software and research technical ideas."],
  "preferences": ["Use concise wording and favor concrete next steps."],
  "source": "Preferences explicitly supplied by the user."
}
```

The loader accepts only these fields and applies size/type limits. Missing, invalid, or oversized files produce ordinary suggestions without personal context. Existing files are never overwritten by startup. Restart the bridge after editing this file because the provider reads it when constructed.

The context is included only in live Astra suggestion requests, alongside the isolated screenshot and optional coarse attention point. It is not sent in the computer-action planning prompt or attached to local learning metrics. Live mode requires the existing screenshot-sharing consent. Practice mode stays deterministic and does not use this background to pretend it is a learned live prediction.

Confirmed current goals and explicit rejection of all offered goals are the learner's observed labels. Looking, cancellation, Stop, background facts, and model-generated guesses are not observed labels. Report held-out prediction measurements separately from the presence of personal context.

Matt's local development checkout was seeded from his explicit project instructions and this Nerve conversation. That private file is not part of the repository or the distributed application, and contains no imported social-message history. Deleting it disables the background on the next bridge restart; the browser's separate **Remember me on this device** control manages saved calibration and learned intent parameters.
