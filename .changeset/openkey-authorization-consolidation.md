---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
"@tinycloud/sdk-services": minor
"@tinycloud/cli": minor
---

Add versioned OpenKey authorization protocol (v1) types and consumer wiring.

- `sdk-core` exports `TinyCloudAuthorizationRequestV1`, `TinyCloudAuthorizationResultV1`, `CapabilityPresentationEnvelopeV1`, `validateAuthorizationResultV1`, `isPlausibleOpenKeyActionId`, `OPENKEY_ACTION_ID_SEPARATOR`.
- `node-sdk` adds `NodeUserAuthorization.signInWithOpenKeyResult()` which completes the session with the exact `signedMessage` the OpenKey widget returned (not the caller's original prepared SIWE). Verifies signer address matches the local signer and refuses if the SIWE does not reference the expected space.
- `cli` browser-auth advertises `protocolVersion=1` on the /delegate URL, validates every callback payload before persisting, and (when the response includes effective `permissions`) refuses any grant that broadens the requested set.
