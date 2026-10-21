---
"@tinycloud/node-sdk": minor
"@tinycloud/sdk-services": minor
"@tinycloud/web-sdk": minor
---

`storage.full` now fires once per episode of the signed-in account's own storage being full, instead of re-arming on every status read. The episode ends only when a write to that storage succeeds, so `storage.status()` reporting room no longer re-arms the event. Breaking for code that relied on a status read to re-arm `storage.full`: call a write to see the next event. Delegated owners each still emit once until they are cleared by a status read or a successful write.

web-sdk panel: adds a storage section showing the account's usage and state (ok, nearly full, full, unlimited). While the own-storage episode is active the panel shows "Storage is full" and hides the numbers, even if status still reports room. The needs-permission "Allow" action calls the internal `requestAuthority` hook, which is not wired yet (lands with B2); until then it settles on unavailable. The section's manage link uses the status `manageUrl` only when it is https and otherwise falls back to the SDK's storage manage URL.

web-sdk host: while the own-storage episode is on, the button and panel show "Storage is full" and one warning toast with a manage link is shown per episode, even with the panel closed. A new toast appears only after the episode ends and a new one starts.
