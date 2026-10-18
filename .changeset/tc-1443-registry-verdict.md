---
"@tinycloud/sdk-core": minor
---

Add the three-state registry verdict (TC-1443, TC-1444): `registered`, `unregistered` or `unavailable`.

New export `classifyRegistryLookup(subject, response, { rememberedSequence })` classifies one location registry response without doing I/O:

- `unregistered` only for a 404 whose body, without surrounding whitespace, is exactly the registry's `{"error":"location record not found"}`, and only when no sequence is remembered for the subject.
- `registered` for a 200 with a valid v1 record for the exact subject, a verifying signature and a sequence not below the remembered one. Each host is an HTTP(S) origin from a plain host multiaddr; a record with no such entry is `registered` with `hosts: []`.
- `unavailable`, with a `reason`, for everything else: network error, timeout, other statuses, oversize or malformed bodies, subject mismatch, bad signature, an older sequence than remembered, or a not-found for a subject remembered as registered.

The subject must be a canonical `did:pkh:eip155:<chainId>:<EIP-55 address>` or an Ed25519 `did:key`; anything else throws `RegistryLookupInputError`.

Also exported: the verdict types, `RegistryLookupInputError`, `REGISTRY_LOOKUP_MAX_BODY_BYTES` and `REGISTRY_NOT_FOUND_BODY`. Shared test vectors and their rules are in `packages/sdk-core/test-vectors/registry-verdict/`.

Nothing changes in host resolution: `resolveTinyCloudHosts` and the hosted fallback behave as before.
