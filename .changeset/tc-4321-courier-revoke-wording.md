---
"@tinycloud/courier": patch
---

The `courier revoke <peer>` help says what revoke ends: the read access you gave that peer and the pairing. Another agent you own can read and change your mailboxes with its own approval, so revoke doesn't end its access; to end it, revoke that agent's approval at account.tinycloud.xyz/delegations. The out-of-date approval message says the same about key rotation. Text only; revoke behaves the same.

Details: TC-4321
