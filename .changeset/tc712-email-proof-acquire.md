---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

feat(credentials): add email-proof credential acquisition

- `@tinycloud/node-sdk/credentials` exports `requestEmailProofCode`, `completeEmailProof`, and `acquireEmailProof` for a two-step flow: request a one-time code for an address, then exchange it for a verifiable credential.
- Errors are `EmailProofError` with a `step`, a stable `code`, `retryAfterMs`, and `recoverable`.
- `@tinycloud/node-sdk/credential-pending-store` provides a file-backed pending store: owner-only files, 15-minute maximum lifetime, deleted after success or any unrecoverable failure.
- `@tinycloud/web-sdk` re-exports the same types. Existing root behaviour is unchanged; the root bundle contains no email-proof code.
- `@tinycloud/sdk-core`: `CredentialError` accepts an explicit `recoverable` flag that overrides the per-code default. `@tinycloud/node-sdk` needs this to keep the witness's recoverable flag on server errors.

Release order: `@tinycloud/sdk-core`, then `@tinycloud/node-sdk`, then `@tinycloud/web-sdk`. Node-sdk pins sdk-core exactly, so sdk-core must publish first for that pin to carry the recoverable override.

Details: TC-712
