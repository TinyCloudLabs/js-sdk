---
"@tinycloud/sdk-core": minor
---

Update the held-credential verifier: input size and nesting limits, strict UTF-8 and integer-only JSON numbers, `jti` as a urn:uuid v4, header members limited to `alg`, `typ` and `kid`, cofactorless Ed25519 verification, EIP-55 SIWE addresses, exact RFC 3339 SIWE dates, canonical `result.subject`. `IssuerSet` is created only by `parseIssuerSet`, and `verifyHeldPresentation` accepts only that type. Import one build (ESM or CJS) of `@tinycloud/sdk-core/held-credentials` per process. Details: TC-1540
