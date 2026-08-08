---
"@tinycloud/share-envelope": patch
---

Use the browser-safe base64url codec when verifying compact UCAN roots, even when the host bundle exposes a partial `Buffer` polyfill.
