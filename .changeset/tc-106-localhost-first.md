---
"@tinycloud/sdk-core": minor
"@tinycloud/web-sdk": minor
"@tinycloud/node-sdk": minor
"@tinycloud/cli": minor
---

Add localhost-first node resolution with identity pinning. Before falling back to registry/hosted resolution, `resolveTinyCloudHosts` now probes for a locally-running TinyCloud node (loopback, then `*.local.tinycloud.link`) and uses it if it answers and passes DID identity verification (trust-on-first-use, pinned per consumer). New opt-out and config knobs: `autoDiscoverLocalNode` (default true), `localNodeUrl`, `localLinkName`, `expectedNodeDid`, surfaced on node-sdk, web-sdk, and the CLI. Explicit host configuration (`host`, `--host`/`TC_HOST`) continues to skip discovery entirely.
