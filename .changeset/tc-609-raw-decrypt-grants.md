---
"@tinycloud/node-sdk-wasm": patch
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/cli": patch
---

A local-key grant of only raw decrypt on the owner's encryption network can be stored and used again (TC-609). `tc auth request --grant` and a secret read's escalation activated such a grant, then refused to store it, because verifying it reused the persisted-session check that a session's ReCap authorizes its primary space, and a raw network names no space. The new WASM export `validateSessionGrant` (optional `IWasmBindings.validateSessionGrant`, implemented by `NodeWasmBindings`) runs the same signature, signer, audience, lifetime, ReCap and CID checks, and waives the space check only for a grant whose ReCap holds nothing but raw encryption-network resources; a grant with no ReCap authority is refused. `TinyCloudNode.verifySessionGrant` uses it, falling back to `validatePersistedSession` (which refuses decrypt-only grants) for bindings without it. Restoring a session still uses `validatePersistedSession` and its space check.
