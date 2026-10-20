---
"@tinycloud/sdk-core": minor
---

Harden the held-credential verifier (TC-1540): size and depth limits before any parse, strict UTF-8, integer-only JSON numbers, `jti` must be a urn:uuid v4, header members limited to `alg`, `typ`, `kid`, duplicate `_sd` digests refused, cofactorless Ed25519 verification, EIP-55 SIWE addresses, exact RFC 3339 SIWE dates, canonical `result.subject`, and `@ab`/`ab@` emails refused. `descriptorDigest` is no longer an accepted signed claim of the email row. API change: `IssuerSet` is now an opaque class that only `parseIssuerSet` can create, and `verifyHeldPresentation` refuses any other object as `issuerSet`. Not yet released, so no published consumer is affected. Import only one build (ESM or CJS) of `@tinycloud/sdk-core/held-credentials` per process: an `IssuerSet` from the other build is refused as `bad-config`.
