# Credential acquisition v1

`tinycloud.credentials/acquisition/v1` is an exact-match protocol version. The
only v1 proof primitives are `collect_input@1`, `mailbox_otp@1`, and
`holder_signature@1`. Unknown protocol, descriptor, profile, format, registry,
step, or signing-domain versions fail with `UNSUPPORTED_VERSION` or
`UNSUPPORTED_PROFILE`; implementations must never downgrade.

Descriptors are canonicalized as RFC 8785/JCS UTF-8 and identified by SHA-256
base64url without padding. Availability is outside descriptor bytes, so health
changes do not change a pinned descriptor digest. A client may execute a pinned
descriptor without discovery.

All descriptor endpoints are identifiers from the registry. They resolve
against the descriptor's exact trusted HTTPS issuer origin. Descriptors cannot
specify URLs, methods, headers, scripts, markup, or executable expressions.

The request locator is opaque but not authorizing. Status and result access
require the high-entropy completion verifier whose S256 challenge was bound at
creation. Popup and redirect URLs carry only the locator. Cross-window messages
may carry only `{type, version, requestId, state}` wake/progress fields; they
never carry identifiers, proof material, credentials, or authorization.

TC-452 compatibility is strict: `/v1/share-email/*`, `/share/v2`, the
`tinycloud.share-email-claim/v1` signing domain, and migrations 0001–0006 are
unchanged. Generic acquisition uses migration 0007 and has no share CID,
policy CID, delegation CID, share URL, or sharing-authority fields.

## Trust, cache, readiness, and key rotation

Discovery is authenticated by the exact HTTPS origin. Issuer identity is also
checked through the canonical DID and its key material. Catalog responses use a
five-minute freshness lifetime, ETag revalidation, and one-hour
`stale-if-error`; pinned descriptors remain usable while discovery is down.
Unknown keys force metadata revalidation and then fail closed. Rotations publish
old and new keys for at least 24 hours, issue only with the active key, retain
old keys through the longest credential validity window, and reject retired
keys. Capability (`supported`, `enabled`) is separate from health (`ready`,
`degraded`, `disabled`).

## Threat model

| Threat | Required control |
| --- | --- |
| Descriptor/profile substitution | Bind exact versions and descriptor digest in request, holder signature, credential, and verification. |
| Challenge or completion replay | Atomic one-time transitions, nonce/JTI uniqueness, verifier authentication, bounded TTL and attempts. |
| Confused deputy | Bind requirement digest, holder DID, issuer, audience, exact origins, and completion context. |
| Downgrade | Exact version negotiation and typed fail-closed errors. |
| Origin confusion | Exact HTTPS origins, explicit CORS allowlist, no wildcard messages or credentials mode. |
| Enumeration | Identical authentication failures; locator alone reveals no status. |
| Metadata poisoning | HTTPS + DID/key verification, JCS digest pinning, ETag revalidation, key-overlap rules. |
| Secret exfiltration | No secret URLs/messages; result bytes require the verifier and are returned only from the result endpoint. |
