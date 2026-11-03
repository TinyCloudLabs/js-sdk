---
"@tinycloud/courier": patch
---

`courier init` works out where it stands once, from the profile status, the saved grant, the agent key, a saved redeemed grant, the saved approval request and the key-rotation record, and every mode (`--request`, `--wait`, `--resume`, `--rotate-key`, `--grant-file`) recovers from that one result. `init --resume` continues as `init --wait` when an approval from the owner is saved and no grant is waiting to be installed, and the `--wait` advice follows the same result. A `grant.json` that is cut short or is not a grant counts as no saved grant and is reported once. A saved approval whose profile or agent key is missing is refused without changing any file. `init --rotate-key` replaces the agent key, the profile and the grant as one journaled step that is finished by the next `init` if it is interrupted; it still discards a held approval with a warning, and says so with the revoke page when the approval already held a granted result.

Details: TC-2383
