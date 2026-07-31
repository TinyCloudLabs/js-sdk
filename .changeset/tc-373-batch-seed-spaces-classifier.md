---
"@tinycloud/sdk-core": minor
"@tinycloud/web-sdk": minor
"@tinycloud/node-sdk": minor
"@tinycloud/sdk-services": minor
---

TC-373: fix two blockers found in review of the batched account-bootstrap seed-spaces write.

- `KVService.batchPut` now attaches structured metadata (`requestMayHaveDispatched`, and on the two unconfirmed-2xx response paths, `responseReceived` / `status` / `outcome: "batch-unconfirmed"`) to `NETWORK_ERROR`/`TIMEOUT` failures instead of leaving them unclassified. No new `ErrorCodes` member is added — the ambiguity is carried entirely in `meta` to avoid widening the exported `ErrorCode` union.
- `AccountService.spaces.registerBatch`'s internal ambiguous-failure classifier is now a strict allow-list (previously a deny-list that defaulted to "retry", so deterministic failures like 400/409/422, `INVALID_INPUT`, and 501/505 triggered five pointless per-space reconcile puts). `registerBatch` now returns `RegisterBatchSuccess` (`{ spaces, recoveredFromBatchError? }`) instead of a bare array, so a batch write that recovers via per-space reconciliation is visible on the success payload, not only via `console.warn`.
- `TinyCloudNode.bootstrapStatus` gains an optional `warnings?: BootstrapWarning[]` field: bootstrap that completes via a recovered ambiguous write is now programmatically distinguishable from a clean run (both were previously `{ skipped: false }`).

Both changes are additive; nothing published is broken.
