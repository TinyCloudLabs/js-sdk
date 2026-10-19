---
"@tinycloud/cli": patch
---

A failed or cancelled replica-enabled OpenKey login (interrupt, expiry, invalid signature, paste EOF or a failed commit) no longer signs out the profile's existing session: it never denies an already-active replica gate, so the live session's unsynced writes are kept. Only a gate that the failed attempt itself bound, and that no saved session holds, is denied again.
