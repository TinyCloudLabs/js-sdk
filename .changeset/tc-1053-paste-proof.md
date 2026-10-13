---
"@tinycloud/cli": patch
"@tinycloud/operations": patch
---

`tc auth login --method openkey`, including `--paste`, now requires a SIWE proof signed for this profile's session key, and saves nothing without one (TC-1053). Before, a plain login (with no `--manifest`, `--owner` or `--expiry`) stored a pasted delegation that had no signature, reported `authenticated: true` and took the profile's `spaceId` from unverified input. Such a paste now fails with `OPENKEY_PROOF_INVALID` (exit 3). Real OpenKey logins always carry this proof and are unaffected.

The approved session's space must also belong to the account that signed it (`OPENKEY_SCOPE_MISMATCH`), and the saved session always signs with the profile's own key, never a key echoed by the callback.

A session without a signed proof on an OpenKey owner profile is now reported as `unverified` by `auth status`, `whoami`, `context` and `status`. Commands refuse it, printing the sign-in command, instead of sending it to the node. That covers both the CLI's own restore and the operations runtime behind `tc secrets` and the MCP server (`ownerSessionLacksProof` in `@tinycloud/operations/profile`). It applies to anything the old unverified login saved, and to legacy delegation imports on profiles with no recorded posture. Sign in again, or re-import into a delegate-session profile.

This doesn't yet tie the proof to this particular login attempt: on a profile with no pinned owner, any wallet's valid proof for the session key is still accepted (TC-1058).
