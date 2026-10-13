---
"@tinycloud/cli": patch
---

`tc auth login --method openkey`, including `--paste`, now refuses a delegation that doesn't carry a verifiable OpenKey proof for this profile's key, and saves nothing (TC-1053). Before, a plain login (with no `--manifest`, `--owner` or `--expiry`) stored any pasted delegation that lacked a SIWE signature, reported `authenticated: true` and took the profile's `spaceId` from unverified input. OpenKey always returns a signed proof, so real logins are unaffected. A paste without one now fails with `OPENKEY_PROOF_INVALID` (exit 3).
