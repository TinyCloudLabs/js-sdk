---
"@tinycloud/share-envelope": minor
"@tinycloud/cli": minor
---

Add immutable, signed OpenKey approval-request links using the shared `/a/<id>#v=4&k=<key>&c=<sealedBodyCid>` grammar. Requests default to one hour, are capped at 24 hours, and use repeatable non-consuming reads. Validate the sealed issuer, target Ed25519 key, and P-256 result encryption key without changing existing login, share, or courier links.

Use these short requests for browser approval in the CLI and onboarding. Recover the encrypted result through repeatable requester-authenticated fetches, verify the signed authority, and durably save the profile and stable ACK intent before acknowledgement. Explicit manual paste remains available with the existing return-code contract.

Bind agent-grant approvals to the exact prepared request. Durably retain the verified child grant, command output, history, and signed-parent/ACK binding before acknowledgement, so retries recover the saved result rather than issuing another grant.

Details: TC-2212
