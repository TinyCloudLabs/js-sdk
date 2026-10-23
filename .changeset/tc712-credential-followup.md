---
"@tinycloud/node-sdk": minor
"@tinycloud/courier": minor
---

`@tinycloud/node-sdk/credentials` adds `verifyStoredEmailProof`, which re-verifies a stored email-proof credential offline: descriptor digest pin, envelope rebuild, pinned issuer keys, status check, and holder match. `@tinycloud/node-sdk/credential-pending-store` exports `ensureSecureDir` and `checkSecureDir`. The credentials directory must be a real directory with owner-only mode; a symlink or a file is refused, and a pre-existing directory with loose permissions is refused rather than chmodded. A pending request expires at the earlier of the witness expiry and 15 minutes after creation.

`courier credential acquire` writes one JSON object to stdout per call: `status: "code-sent"` with `codeExpiresAt` on the first call, then `status: "acquired"` with `issuedAt` and `expiresAt` on the second. The verification code must be entered within 5 minutes. `courier credential show` prints `address`, `credentialId`, `issuedAt`, `expiresAt`, and `status`, never the credential. Stored credentials are re-verified offline on every read, and are dropped 60 seconds before their own expiry or once older than the 3600-second maximum age. Courier refuses to run when both `HOME` and `COURIER_HOME` are unset. `courier --version` prints the package version.

Details: TC-1757
