---
"@tinycloud/node-sdk": minor
"@tinycloud/sdk-services": minor
"@tinycloud/web-sdk": minor
---

`storage.full` now fires once per episode of the signed-in account's own storage being full, instead of re-arming on every status read. The episode ends only when a committing write succeeds (kv `put` and `batchPut`, vault `put`, and SQL and DuckDB write actions). A successful `delete` or `get` does not end it, and `storage.status()` reporting room no longer re-arms the event. Breaking for code that relied on a status read to re-arm `storage.full`: call a committing write to see the next event. Delegated owners each emit once until a status read or a successful committing write clears them. Adds `storageEpisode.subscribeDelegated` on node-sdk and web-sdk to observe delegated-owner episodes.

web-sdk panel: adds a storage section showing the account's usage and state (ok, nearly full, full, unlimited). While the own-storage episode is active the panel shows "Storage is full" and hides the numbers, even if status still reports room. The needs-permission state offers "Allow" only when the client can ask for authority; otherwise it shows the permission note with no action. The manage link uses the status `manageUrl` only when it is https and otherwise falls back to the SDK's storage manage URL.

web-sdk host: while the own-storage episode is on, the button and panel show "Storage is full", and one info toast with a manage link is shown per episode, even with the panel closed. A new toast appears only after the episode ends and a new one starts. Delegated owners that are full get the same info toast. The toast reads the manage link from status at toast time, so each toast adds one status request. A toast whose status read finishes after its episode has ended is not shown.
