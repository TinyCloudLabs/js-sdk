---
"@tinycloud/node-sdk": patch
"@tinycloud/cli": patch
---

A fresh owner's first private-key sign-in (`tc auth login --method local`, or `TinyCloudNode.signIn()` with a private key) no longer warns `account bootstrap failed: … 401 - Unauthorized Action: …:account/sql/account / tinycloud.sql/schema`, and it creates the account index, registry and bootstrap marker on the account space. Previously these were only repaired on the next sign-in. The default bootstrap session now signs each requested permission onto its own space, as sign-in already does, and an operation on another space that a bootstrap session covers is invoked against that space (TC-957).
