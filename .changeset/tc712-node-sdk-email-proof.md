---
"@tinycloud/node-sdk": minor
---

Adds email-proof credential acquisition as `@tinycloud/node-sdk/credentials-core` (narrow entry, no web-sdk dependency) and `@tinycloud/node-sdk/credential-pending-store` (owner-only, one file per pending request). The `@tinycloud/node-sdk/credentials` entry adds `requestEmailProofCode`, `completeEmailProof`, `acquireEmailProof`, `createEd25519HolderSigner`, `emailProofRequirement`, and `EmailProofError`. The root entry gains no email-proof exports.

Details: TC-712
