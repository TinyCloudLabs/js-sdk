---
"@tinycloud/sdk-core": minor
"@tinycloud/web-sdk": minor
---

Refine the SDK-owned inline credential view for exact-email share claims.
The view names the mailbox the code was sent to (taken from the digest-bound
credential requirement), collects the 8-digit mailbox code through one
accessible `one-time-code` field rendered as grouped slots, normalizes pasted
and full-width codes, and follows host light/dark tokens
(`--tinycloud-credential-*`, including a separate `-field-line` token for 3:1 field boundaries). A rejected code is re-entered against the same
challenge until the descriptor's attempt budget is spent, reported through the
new recoverable `PROOF_REJECTED` credential error, which never escapes the
interpreter: an exhausted budget surfaces as non-recoverable
`VERIFICATION_FAILED` (`state: "proof_attempts_exhausted"`), and an expired
challenge still ends the acquisition. `share.receive` now binds the
invitation's exact-email recipient to the owner-signed policy commitment before
returning and exposes it as `ReceivedShare.recipient`. Inline host proof
handlers (`InlineCredentialProofHandler`) still never receive requirement
values; only the SDK-owned view shows the mailbox.
