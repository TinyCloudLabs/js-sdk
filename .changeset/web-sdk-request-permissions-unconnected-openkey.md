---
"@tinycloud/web-sdk": patch
---

`requestPermissions` on a restored session whose OpenKey client was never connected no longer opens an OpenKey sign popup that hangs on "Please connect first to sign messages." It refuses before any popup, with no OpenKey call, and the node throws its usual "grantRuntimePermissions requires wallet mode with a signer or privateKey." error, as in 3.8.0. The OpenKey client still signs the runtime grant when this instance's session was established through it, or when its `connect()` has run (the client's in-memory `lastAuth` is set); a client that does not expose `lastAuth` (an `@openkey/sdk` shape this SDK does not know) behaves as before. A signer set with `setRuntimePermissionSigner` still wins, and a wallet-mode session signs with its own signer.

Details: TC-2281
