---
"@tinycloud/cli": patch
"@tinycloud/operations": patch
"@tinycloud/replica": patch
---

Pin profile and replica directories during reset and logout cleanup. Reject whole-profile and replica database symlinks and changed SQLite file identities before mutations. Profile operations and destructive replica cleanup now refuse unsupported platforms rather than risk following a replaced directory.
