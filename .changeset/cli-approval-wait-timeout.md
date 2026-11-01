---
"@tinycloud/cli": minor
---

`tinycloud onboard` and `tinycloud auth grant` accept `--timeout <Ns|Nm>` (more than zero, at most 9m; anything else is a usage error, exit 2 `INVALID_TIMEOUT`) to bound the wait for the owner's OpenKey approval. A new approval link exits 8 at once with `{"pending":{"step","of","approvalUrl","expiresAt"}}` on stdout, so an agent can send it immediately; a resumed link keeps waiting until the timeout and then exits 8 with the same JSON; an approval that arrives is collected, verified, saved and acknowledged exactly once (exit 0), even past the timeout. `onboard` has 2 steps, `auth grant` is step 1 of 1. An expired request is still exit 3, and OpenKey being unavailable is still its own exit 8 error without the `pending` object. Without `--timeout` nothing changes.

Details: TC-2299
