---
"@tinycloud/courier": patch
---

`courier intake` and `courier outbox serve` accept `--peers-owner <name|uid>` (or `COURIER_PEERS_OWNER`) to name the account that must own `peers.json`. A user name is looked up in `/etc/passwd` and must match exactly one uid; accounts that exist only in NSS need the numeric uid. Without the flag the default is the running user on POSIX systems; elsewhere startup refuses unless the flag is given. The mode, symlink, and regular-file checks are unchanged.

Details: TC-1634
