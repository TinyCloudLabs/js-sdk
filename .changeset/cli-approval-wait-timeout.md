---
"@tinycloud/cli": minor
---

`tinycloud onboard` and `tinycloud auth grant` accept `--timeout <Ns|Nm>` (more than zero, at most 9m; anything else is a usage error, exit 2 `INVALID_TIMEOUT`; `onboard` refuses it together with `--code`) to bound the wait for the owner's OpenKey approval. Exit 8 with `{"pending":{"step","of","approvalUrl","expiresAt"}}` on stdout is not a failure: it is printed at once when a new approval link exists (so an agent can send it to the owner immediately) and again when a resumed link is still unanswered at the timeout; run the same command again. An approval the owner already gave is never reported as pending: it is collected, verified and saved, and acknowledged, even past the timeout (up to 30 s more, so `--timeout 60s` ends in about 100 s at the most; an acknowledgement whose reply is lost is re-sent with the same id on the next run). `onboard` has 2 steps, `auth grant` is step 1 of 1. An expired request is exit 3, and OpenKey being unavailable is still its own exit 8 error without the `pending` object. Without `--timeout` nothing changes.

Details: TC-2299
