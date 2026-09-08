# Local bridge API

Development UI: `http://127.0.0.1:4317`. Bridge and production UI: `http://127.0.0.1:4318`.

The bridge binds to loopback, validates Host and Origin, rejects cross-site requests, disables caching, and requires JSON for mutations. It is not a multi-user service. Never expose it publicly. One session is shared by all locally opened Nerve UI tabs.

| Endpoint               | Input                                                                         | Output                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /api/health`      | none                                                                          | Availability, model name, configured boolean, privacy boundary                                               |
| `GET /api/state`       | none                                                                          | `SessionState`, including last captured screenshot and current proposal                                      |
| `POST /api/session`    | `{mode,screenConsent:boolean,url?:string}`, mode is `"practice"` or `"astra"` | Opens fresh isolated browser, returns state                                                                  |
| `POST /api/intent`     | `{goal:string,expectedRevision?:number}`                                      | Starts bounded planning asynchronously; a supplied stale revision returns 409 before planning                |
| `POST /api/candidates` | `{point?:{x:number,y:number}}`                                                | `{candidates,source,state}`; the state is the fresh observation the suggestions describe; no computer action |
| `POST /api/approve`    | `{proposalId:string,revision:number}`                                         | Consumes exact current approval and begins execution                                                         |
| `POST /api/stop`       | `{}`                                                                          | Invalidates approvals, cancels pending requests and queued actions                                           |
| `POST /api/reset`      | `{}`                                                                          | Closes the disposable browser and resets session state                                                       |
| `GET /api/lab-state`   | none                                                                          | Synthetic sample app state, only in the bundled local lab                                                    |

`point` is normalized to the displayed browser image in `[0,1]` coordinates, not pixel coordinates. Computer actions use the fixed browser viewport's pixel coordinates. The UI screenshot may be scaled, but action coordinates are not rescaled during execution.

State types live in `shared/types.ts`. The UI polls state serially. Intent and approval requests return before asynchronous provider/execution work finishes. A `completed` model tool call is not proof of execution. Only the local executor changes browser state.

State polling reads the last captured image, not a continuous screen recording. Requesting candidates captures a fresh image before analyzing it. It is rejected while an action proposal is awaiting approval, preserving that proposal's exact screen binding. Stop ignores late work; its image may precede an already-dispatched action. Resume only enables input, and **Read this screen** can then refresh the image without authorizing browser actions.

## Authorization

Intent selection is not action authorization. Approval must match the current UUID, revision, unexpired proposal, and current screenshot. Double approvals are rejected. A screenshot change invalidates the action even if it appears harmless. Stop invalidates all old approvals. Resume on the client does not authorize continuation of a stopped task.

The current limits are 32 primitive actions, 12 model responses, and 10 minutes per intent, with 60 seconds per provider request. A proposal expires after 2 minutes. Suggestions have a per-session request budget and rate limit. Exact values are defined in `server/session.ts`.

## Errors

Errors return `{error:string}` with a non-2xx HTTP status. Messages are sanitized and never echo API keys or provider response bodies. Common statuses: 400 invalid payload, 403 disallowed origin/destination, 409 busy/stale state, 413 oversized request, 415 non-JSON mutation, 429 provider or request limit, 503 unavailable configuration/runtime.

## Privacy

The browser's intent learner has no server endpoint. Teaching, check-only evaluation, live attention updates, and model persistence stay in the UI. A normal accepted intent request supplies an explicit training label locally; `/api/approve` remains the separate action boundary. The UI sends `expectedRevision` with task selections and ignores late responses after Stop or session replacement. Poll results cannot replace the decision snapshot while its intent request is in flight.

Do not proxy or log response bodies: `/api/state` contains a screenshot of the allowed browser. Session export intentionally omits screenshot/video fields but may include user text in action descriptions. Screen content is untrusted input and cannot grant authority to run arbitrary code, change goals, or access other origins.
