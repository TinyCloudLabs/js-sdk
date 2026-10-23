---
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

Adds `buildSharePresentation` and `SharePresentationError` to `@tinycloud/node-sdk/credentials`. It builds a policy-v3 (node route-B) credential presentation from a node challenge, a verified credential, and a holder signer. It fails closed with a stable `SharePresentationError.code` before signing. Route-A (share) challenges are rejected with `CHALLENGE_ROUTE_UNSUPPORTED`.

Recipient binding uses `CHALLENGE_RECIPIENT_MISMATCH` (`challenge.recipientDid` must equal `holderSigner.did`). This replaces the unreleased `RECIPIENT_MISMATCH` code used earlier on this branch.

`@tinycloud/web-sdk/credentials` re-exports `buildSharePresentation`, `SharePresentationError`, and the `SharePresentation*` types. The root entry gains no exports.

Details: TC-1757
