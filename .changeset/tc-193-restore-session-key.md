---
"@tinycloud/sdk-core": patch
"@tinycloud/sdk-services": minor
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk-wasm": patch
"@tinycloud/web-sdk-wasm": patch
---

Restore persisted sessions with their original private Ed25519 signer. Verify the signed SIWE, ReCap, Cacao header/CID, address, chain, session DID, and expiry before installing authority; atomically replace the auth/core/service host context while retaining every live secondary signer. Retired service graphs abort outstanding work and cannot reuse old encryption authority. Browser restore now preserves spaces and policy expiry, and rejected restores leave persisted storage untouched.
