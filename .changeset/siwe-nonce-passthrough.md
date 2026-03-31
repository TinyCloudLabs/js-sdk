---
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
---

Fix siweConfig.nonce passthrough to SIWE message generation

The nonce field from siweConfig was accepted in the configuration but never
forwarded to the WASM prepareSession() call, causing server-provided nonces
to be silently ignored. This broke single-signature auth flows where an
external service (e.g. billing sidecar) provides a nonce for verification.
