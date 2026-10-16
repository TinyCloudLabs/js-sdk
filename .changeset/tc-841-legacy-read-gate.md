---
"@tinycloud/cli": patch
---

Require a persisted owner replica stamp and active profile gate for legacy local replica get, list, and status. Serialize reads and output with sign-out denial, and refuse a pending logout marker before and after local reads so interrupted cleanup cannot serve retained replica data.

Legacy logout cleanup accepts only the approved path, type, and inode inventory recorded in the logout marker; an unlisted or replaced file leaves cleanup pending instead of broadening `--discard-local-changes`.
