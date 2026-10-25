---
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

Adds `buildSharePresentation` and `SharePresentationError` to `@tinycloud/node-sdk/credentials`. It builds a policy-v3 (node route-B) credential presentation from a node challenge, a verified credential, and a holder signer. It fails closed with a stable `SharePresentationError.code` before signing. Route-A (share) challenges are rejected with `CHALLENGE_ROUTE_UNSUPPORTED`.

`requestedCapabilities` is required: a non-empty set, each entry contained in the policy capability ceiling, signed exactly as given. Refusals are `REQUESTED_CAPABILITIES_INVALID` and `CAPABILITY_OUTSIDE_CEILING`. Credentials older than 300 seconds on the reviewed OpenCredentials email profiles are refused with `CREDENTIAL_TOO_OLD`, as are credentials past `maxAgeSeconds`.

`@tinycloud/web-sdk/credentials` re-exports `buildSharePresentation`, `SharePresentationError`, and the `SharePresentation*` types. The root entry gains no exports.

Details: TC-1757
