---
"@tinycloud/web-sdk": minor
"@tinycloud/sdk-core": minor
---

Stop browser sign-in hanging forever on an invisible space-creation dialog (TC-362).

`ModalSpaceCreationHandler.confirmSpaceCreation` returned a promise that only ever
settled on a click inside a shadow-DOM `<tinycloud-space-modal>`. When that dialog
was not reachable — for example hidden behind an app's own full-screen "Connecting…"
overlay — `ensureSpaceExists` awaited it forever and sign-in looked permanently stuck,
with nothing in the light DOM to explain why.

- The wait is now bounded (default 2 minutes, configurable via the new
  `TinyCloudWeb` config option `spaceCreationTimeoutMs` or
  `new ModalSpaceCreationHandler({ timeoutMs })`; `0` restores the unbounded wait).
  On expiry the handler closes the dialog and rejects with a `SpaceCreationTimeoutError`
  whose message names the element, the likely cause, and the three ways out.
- **Behaviour change:** `autoCreateSpace` is now honoured in the browser. `TinyCloudWeb`
  used to install the modal handler unconditionally, and node-sdk gives an explicit
  handler precedence over `autoCreateSpace`, so the option was dead config in the browser.
  `autoCreateSpace: true` now creates the space with no dialog, `autoCreateSpace: false`
  skips creation entirely, and leaving it unset keeps today's modal confirmation.
  An explicit `spaceCreationHandler` still wins over both.
- While the SDK is blocked on the user it sets
  `data-tinycloud-awaiting-user-input="space-creation"` on `<html>`, fires
  `tinycloud:awaiting-user-input` / `tinycloud:awaiting-user-input-resolved` on `window`,
  and logs an explanatory warning — so a stuck sign-in is diagnosable from outside
  the shadow root. New helper `pendingUserInputKind()` reports the same state.
- The owner-policy sharing path signs mid-compose by re-opening the wallet/OpenKey
  signing surface. An unanswered or cancelled prompt there used to surface the same
  `PERMISSION_DENIED` "the active session ReCap does not authorize this sharing
  delegation" message as a genuine HTTP 403. It is now reported as `TIMEOUT` or
  `ABORTED` with a message that says what to do, and the underlying error is kept
  as `cause`.
