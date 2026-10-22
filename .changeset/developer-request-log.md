---
"@tinycloud/sdk-services": minor
"@tinycloud/node-sdk": minor
---

Add an opt-in, in-memory developer request log. With `requestLog: true` in `TinyCloudNode` config, the log records requests the SDK makes on your behalf: operation, path (first segment only), space (the name after the last colon), host, size, duration, attempts, result and source. Read them from `node.requests`, a read-only view with `snapshot()`, `subscribe()` and `onClear()`. The log keeps the most recent 500 entries and is cleared on sign-out, on sign-in as another account, and when a session is restored for a different owner. Entries carry sizes only; body and header content is absent from them. When the option is omitted, no log is created and no events are built.
