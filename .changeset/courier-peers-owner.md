---
"@tinycloud/courier": patch
---

`courier intake` and `courier outbox serve` accept `--peers-owner <name|uid>` (or `COURIER_PEERS_OWNER`) to name the account that must own `peers.json`. A user name resolves through the passwd database and must match exactly one uid. The default is still the running user. The mode, symlink, and regular-file checks are unchanged.

Details: TC-1634
