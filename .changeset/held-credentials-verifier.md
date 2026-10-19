---
"@tinycloud/sdk-core": minor
---

Add `@tinycloud/sdk-core/held-credentials`: an off-node, Worker-safe verifier for held `tinycloud.email-held/v1` credentials (SD-JWT VC, EdDSA) with a SIWE holder proof, a pinned issuer set, an atomic `NonceStore` interface, and the shared `normaliseEmail`. `InMemoryNonceStore` is single process only; not safe across instances/isolates/replicas. Non-ASCII emails are refused until G14 lands. Nothing existing changes.
