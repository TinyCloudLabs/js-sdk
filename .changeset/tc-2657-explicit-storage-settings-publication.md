---
"@tinycloud/sdk-core": minor
"@tinycloud/cli": minor
"@tinycloud/operations": patch
---

Add explicit owner-authorized signed-v2 storage-settings publication through `publishLocationRecordV2` from `@tinycloud/sdk-core/registry-publication` and `tinycloud registry publish <space...> --server <url>`. The SDK entry is opt-in so publication code does not enter the Web root. Sign-in does not publish records automatically.

Publish only explicitly selected memberships while preserving existing spaces, server mappings and the decryption service. Verify the owner's signature and destination identities, advance the accepted sequence, and refuse malformed absence, rollback and conflicting updates without automatic write retries. Refuse redirects on registry and identity requests.

Preserve registration history across supported storage-settings formats without changing the existing routing policy.

Show the full public result before confirmation and disclose that anyone who knows the account ID can look up its servers and plaintext space names. Agent keys cannot replace the owner's signing key. Successful CLI publication saves the verified local copy for inspection and the existing bounded outage policy; a local persistence failure after publication reports that remote publication already happened.

Distinguish a successful change from an already-published no-op with JSON `changed: true` or `changed: false`. No-op output retains the public-lookup disclosure without a misleading change marker or an extra PUT. Interactive confirmation states that disclosure once.

Details: TC-2657
