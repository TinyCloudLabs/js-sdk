---
"@tinycloud/cli": patch
---

Legacy local replica get, list, and status with an owner session require its persisted replica stamp and the active profile gate. A session without an owner DID (a delegate's imported grant) reads only while the profile has no gate and no committed sign-out. Serialize reads and output with sign-out denial, and refuse a pending logout marker before and after local reads so interrupted cleanup cannot serve retained replica data.

Legacy logout cleanup accepts only the approved path, type, and inode inventory recorded in the logout marker; an unlisted or replaced file leaves cleanup pending instead of broadening `--discard-local-changes`.
