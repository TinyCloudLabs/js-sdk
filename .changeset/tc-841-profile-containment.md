---
"@tinycloud/cli": patch
"@tinycloud/operations": patch
"@tinycloud/replica": patch
---

Pin profile and replica directories before SQLite opens during reset and sync, and through local report reads, runtime shutdown, and logout cleanup. Reject whole-profile and replica database symlinks, changed SQLite identities, and expired profile descriptors before access. Gate legacy replica reads on pending logout, including aliases and in-flight reads. Resume cleanup of verified empty legacy replica directories after an interrupted purge without deleting unknown files. Keep ordinary profile state access available on non-Linux platforms while unsafe replica purge refuses them.
