---
"@tinycloud/courier": patch
---

A Courier command on a profile left `awaiting-space` now asks the node whether the `agents` space is hosted now (the read `init --resume` makes). When it is, the profile becomes `ready` and the command runs, with no `init --resume` needed. When it is not, the command fails with the same `no-space` error as before and the profile is not changed; an error from the read itself (authentication, network) is reported as it is. If the profile cannot be saved because it changed meanwhile, that refusal is reported instead of the command running.

The `no-space` message now gives the two ways out: turn on Auto-Sign in OpenKey and approve the Courier request again, or run `tc space host agents` from a wallet profile and then `init --resume`. It no longer points to the Share view (the README has the same correction).

Details: TC-2380, TC-2398
