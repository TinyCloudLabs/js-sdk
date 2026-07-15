---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk-wasm": patch
"@tinycloud/web-sdk-wasm": patch
---

Restore persisted sessions with their original private Ed25519 signer, validating that the JWK and verification method identify the same principal before runtime delegation activation.
