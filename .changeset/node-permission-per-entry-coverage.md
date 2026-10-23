---
"@tinycloud/node-sdk": patch
---

Permission checks now judge each entry on its own. `secrets.get` requests only the entries that are not already covered, so a read can complete without a new signature when the session and a runtime grant together cover it. Details: TC-1781
