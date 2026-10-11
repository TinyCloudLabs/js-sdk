---
"@tinycloud/replica": minor
"@tinycloud/cli": patch
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-services": patch
---

Replication prefixes are folders such as `notes/`, or `/` for the whole space (requires a node advertising `kv-sync-root`). Bare paths and `""` are rejected.

For owner sign-ins with unrestricted whole-space KV get coverage, replication adds sync once to the existing whole-space KV recap resource. Narrower owner coverage and delegated/device grants retain per-prefix scope.

Published `@tinycloud/replica` declarations, including `./browser` and `./worker`, are self-contained; consumers do not need `@tinycloud/sdk-services`.

`kvSyncTransport(kv)` discovers the node host exposed by the KV service for whole-space feature checks. If the service does not expose a host, pass `{ host }`; root sync refuses early with a clear error rather than skipping the `kv-sync-root` check.
