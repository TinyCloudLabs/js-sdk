---
"@tinycloud/sdk-core": minor
"@tinycloud/cli": minor
---

Add explicit owner-authorized signed-v2 storage-settings publication through `publishLocationRecordV2` and `tinycloud registry publish <space...> --server <url>`. Sign-in does not publish records automatically.

Publish only explicitly selected memberships while preserving existing spaces, server mappings and the decryption service. Verify the owner's signature and destination identities, advance the accepted sequence, and refuse malformed absence, rollback and conflicting updates without automatic write retries. Refuse redirects on registry and identity requests.

Show the full public result before confirmation and disclose that anyone who knows the account ID can look up its servers and plaintext space names. Agent keys cannot replace the owner's signing key. Successful CLI publication saves the verified local copy for inspection and the existing bounded outage policy; a local persistence failure after publication reports that remote publication already happened.

Details: TC-2657
