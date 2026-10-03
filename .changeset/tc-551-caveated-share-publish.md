---
"@tinycloud/cli": patch
"@tinycloud/sdk-core": patch
---

`tc share publish` refuses a session whose authority for an anyone-with-link share carries signed restrictions (caveats) before storing anything, so a refused publish no longer leaves an orphaned file. It exits 5 with `PERMISSION_DENIED` and says to approve Share publishing without restrictions on a new, dedicated profile (`tc init --name publisher --key-only && tc --profile publisher enable share`). A caveat only on authority the link does not use (such as `tinycloud.capabilities/read` or the addressed `shares/` prefix) does not block publishing, and a session that lacks the link's authority altogether is also refused with `PERMISSION_DENIED` before upload. Addressed (`--to`) shares and signer-backed local-key profiles are unchanged.

`SharingService.preflightGenerate({ path, actions, expiry })` reports, without side effects, whether the session's own authority can issue the delegation `generate` would create: `"ok"`, `"caveated"` (only caveated entries cover it) or `"not-covered"`. It does not consult `onRootDelegationNeeded`.
