---
"@tinycloud/courier": patch
---

`courier init` works out where it stands once, from the profile status, the saved grant, the agent key, a saved redeemed grant, the saved approval request and the key-rotation record, and every mode (`--request`, `--wait`, `--resume`, `--rotate-key`, `--grant-file`) recovers from that one result.

- `init --resume` continues as `init --wait` when an approval from the owner is saved and no grant is waiting to be installed; with a grant waiting it installs the grant and keeps the approval for the next `init --wait`.
- A saved approval whose profile or agent key is missing is refused, and no file is changed (before, `init --wait` and `init --request` started a new request over it).
- A `grant.json` that is cut short or is not a grant counts as no saved grant and is reported once. A `profile.json` that cannot be read is reported as such and never treated as missing.
- `init --rotate-key` replaces the agent key, the profile and the grant as one journaled step that the next `init` finishes if it is interrupted. The record is checked before it is replayed, and a stray temporary key file left by a killed process is overwritten with zeros and removed. It still discards a held approval with a warning; when the approval already held a granted result, or a redeemed grant for the old key was saved, it also says a live grant may exist, until when, and that the owner can revoke it at https://account.tinycloud.xyz/delegations.
- A corrupt key file could print part of the private key in an error message; fixed. Courier now reports only the file name and that it is unreadable or corrupt for the state files it reads with its profile reader (`key.json`, `profile.json`, `grant.json`, `rotation.json`) and for `approval-pending.json`. Parse errors for input a person supplies, such as an invitation passed to `invite join`, are outside this change.
- The saved approval request is read, written and classified in one module (`approval-phase`); the file format and the approval flow are unchanged.

Details: TC-2383
