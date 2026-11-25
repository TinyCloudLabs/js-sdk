---
"@tinycloud/courier": patch
---

The `courier revoke <peer>` help now says what revoke ends: the read access you gave that peer, and the pairing. Another agent you own reads your mailboxes with its own approval, so revoke doesn't end its access; to end it, revoke that agent's approval. The out-of-date approval message says the same about key rotation. Only the text changed; revoke works as before.

Details: TC-4321
