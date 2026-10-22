---
"@tinycloud/sdk-services": minor
"@tinycloud/node-sdk": minor
---

Add an opt-in, in-memory developer request log. With `requestLog: true` in `TinyCloudNode` config, the SDK records the requests your app makes: operation, path (first segment), space, host, size, duration, result and source. Read them from `node.requests`. The log keeps the most recent 500 entries and is cleared on sign-out and account switch. Paths are shortened to their first segment, and secret values are never recorded. Request and response bodies and headers are never recorded. When the option is omitted, no log is created and no events are built.
