---
"@tinycloud/web-sdk": patch
---

In a browser without `crypto.getRandomValues`, the web SDK now throws when it needs random bytes (for keys and nonces) instead of falling back to a non-cryptographic source. Browsers and webviews that have WebCrypto are unaffected.

Details: TC-3007
