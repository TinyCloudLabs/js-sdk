---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Add an optional per-call `nonce` override to `signIn()` while preserving constructor-level `siweConfig.nonce` support.
