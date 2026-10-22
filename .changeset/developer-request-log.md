---
"@tinycloud/sdk-services": minor
"@tinycloud/node-sdk": minor
---

Add an opt-in, in-memory request log. Set `requestLog: true` in `TinyCloudNode` config to read sanitized per-request events from `node.requests` (service, op, path, space, host, bytes, duration, attempts, outcome). Events never include request or response bodies, headers, or secret values, and secrets paths are recorded as `secrets/`. The log keeps the most recent 500 entries and is cleared on sign-out and account switch. Nothing changes when the option is omitted: no log is created and no events are built. Nothing breaks for existing consumers. Session activation and delegation requests are not included in the request log.

Replication traffic is recorded as service `sync` with `path` and `space` set to null, host only, one row per HTTP attempt. The feature probe (`/info`) is recorded as op `sync/info`. Any `KVService.changes()` call is labelled `sync`, including ones a user makes directly, because the label is keyed on the `tinycloud.kv/sync` action rather than on the caller.
