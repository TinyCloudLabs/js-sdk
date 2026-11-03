---
"@tinycloud/courier": patch
"@tinycloud/cli": patch
---

`courier init` works out where it stands once, from the profile status, the saved grant, the agent key, a saved redeemed grant, the saved approval request and the key-rotation record, and every mode (`--request`, `--wait`, `--resume`, `--rotate-key`, `--grant-file`) recovers from that one result. `init --resume` continues as `init --wait` when an approval from the owner is saved, and the `--wait` advice follows the same result. `init --rotate-key` replaces the agent key, the profile and the grant as one journaled step that is finished by the next `init` if it is interrupted.

Details: TC-2383
