---
"@tinycloud/sdk-core": minor
"@tinycloud/web-sdk": minor
---

Refine the SDK-owned inline credential view for exact-email share claims.
The view names the mailbox the code was sent to (taken from the digest-bound
credential requirement), collects the 8-digit mailbox code through one
accessible `one-time-code` field rendered as grouped slots, normalizes pasted
and full-width codes, and follows host light/dark tokens
(`--tinycloud-credential-*`). A rejected code is re-entered against the same
challenge until the descriptor's attempt budget is spent, reported through the
new recoverable `PROOF_REJECTED` credential error; an exhausted budget or
expired challenge still ends the acquisition. `share.receive` now binds the
invitation's exact-email recipient to the owner-signed policy commitment before
returning and exposes it as `ReceivedShare.recipient`. Host proof handlers
still never receive requirement values.
