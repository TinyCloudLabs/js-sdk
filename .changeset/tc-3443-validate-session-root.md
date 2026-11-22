---
"@tinycloud/node-sdk-wasm": minor
"@tinycloud/web-sdk-wasm": minor
---

New `validateSessionRoot` checks a session key's wallet-signed root as `validateSessionGrant` does, without its time window, so it accepts roots that have expired or aren't valid yet. Sign-out uses it to choose the roots it sends. The browser bindings include it.

Details: TC-3443
