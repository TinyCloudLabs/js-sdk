---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": patch
---

A session key can list and revoke the delegations it issued. `DelegationManager.query({ direction: "issued" })` sends one invocation signed by the session's own did:key (capability `tinycloud.delegation/list` on `<did>/delegation`, no proof) and returns the schema-2 page; it needs `delegation-issued-query-v1` in the node's `/info` features and otherwise answers `UNSUPPORTED_OPERATION` ("This node doesn't support listing issued delegations yet"). `queryAllIssued()` follows `nextCursor` until it is absent (pages are ordered by delegation id and may be short). `revokeIssued(cid)` revokes a delegation the key issued with a revocation signed by that key and no proof; revoking an already revoked delegation succeeds, a plain-text 403 is `PERMISSION_DENIED` with the node's message, a 400 invalid cursor is `INVALID_CURSOR`, and a 503 is `CHAIN_TOO_DEEP` (retryable). `TinyCloudNode` wires the session-key signer (`DelegationManagerConfig.sessionInvocationSigner`).

Details: TC-2132
