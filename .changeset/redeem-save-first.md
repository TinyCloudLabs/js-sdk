---
"@tinycloud/courier": patch
"@tinycloud/cli": patch
---

An OpenKey short code is consumed the moment it is redeemed, so a run that was killed after the redeem (an agent tool's two-minute limit hit this) lost the owner's approval and the retry could only say "Delegation code not found". The redeemed delegation is now saved first, to an owner-only `pending-grant.json` in the Courier home (`pending-delegation-code.json` in the CLI profile directory), fsynced and holding public fields only. Re-running with the same code, or `courier init --resume`, finishes from that copy with no second redeem and no second approval; the record is deleted only after the grant and profile are saved (the CLI: after its login or grant commit), and an expired or wrong-key record is never installed. `courier init --resume` also accepts a profile left `awaiting-grant` beside a saved grant. Courier covers `init` with a code, and the CLI covers `--paste` for `auth login`, `init`, `auth rotate`, `auth grant` and `onboard --code`. One limit remains: the first `tc auth login --paste` on a profile with no saved key keeps its new private key only in memory until the login commits, so a kill before the commit needs a fresh approval. Nothing changes when a run is not interrupted: every message and exit code is unchanged, and no flag is added.

Details: TC-2301
