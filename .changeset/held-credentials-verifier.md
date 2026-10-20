---
"@tinycloud/sdk-core": minor
---

Add `@tinycloud/sdk-core/held-credentials`: an off-node, Worker-safe verifier for held `tinycloud.email-held/v1` credentials (SD-JWT VC, EdDSA) with a SIWE holder proof, a pinned issuer set, a `NonceStore` interface and the shared `normaliseEmail` (ASCII addresses). Deployments supply a shared `NonceStore`; `InMemoryNonceStore` is for tests and single-process tools. Nothing existing changes. Details: TC-1540
