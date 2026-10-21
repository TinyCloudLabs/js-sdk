---
"@tinycloud/sdk-services": minor
"@tinycloud/node-sdk": minor
---

Add an opt-in, in-memory request log. Set `requestLog: true` in `TinyCloudNode` config to read sanitized per-request events from `node.requests` (service, op, path, space, host, bytes, duration, attempts, outcome). Events never include request or response bodies, headers, or secret values, and secrets paths are recorded as `secrets/`. The log keeps the most recent 500 entries and is cleared on sign-out and account switch. Nothing changes when the option is omitted: no log is created and no events are built. Nothing breaks for existing consumers.
