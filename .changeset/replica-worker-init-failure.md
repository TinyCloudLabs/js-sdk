---
"@tinycloud/replica": patch
---

The kv-storage worker reports a start-up failure (for example WebAssembly blocked by a CSP) to the main thread, so replica calls fail at once and reads fall back to the network instead of timing out.
