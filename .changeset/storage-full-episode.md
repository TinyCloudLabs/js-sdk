---
"@tinycloud/node-sdk": minor
"@tinycloud/sdk-services": minor
---

`storage.full` now fires once per episode of the signed-in account's own storage being full, instead of re-arming on every status read. The episode ends only when a write to that storage succeeds, so `storage.status()` reporting room no longer re-arms the event. Breaking for code that relied on a status read to re-arm `storage.full`: call a write to see the next event. Delegated owners each still emit once until they are cleared by a status read or a successful write.
