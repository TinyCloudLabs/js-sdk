---
"@tinycloud/mcp": patch
"@tinycloud/operations": patch
---

Diagnostics only: the hosted MCP's `/connect/callback` now says which stage refused an approval. Nothing about what is accepted, refused or stored changes. A refusal is still `400`, and its body adds `error` (the stage: `restore_approval`, `siwe_runtime_delegation`, `auth_import`, `activation` or `unknown`) and `code` (for example `DELEGATION_REJECTED`, `AUTH_EXPIRED`, `CALLBACK_INCOMPLETE`, `SESSION_MISMATCH`, `UNKNOWN`), with an optional `reason` (a `RuntimeDelegationRejectedError` reason such as `activation_rejected` or `proof_invalid`; any other value is reported as `unknown`). The human-readable text moves to `message`.

The server also writes one stderr line per refusal: `[tinycloud-mcp-http] connect callback rejected: stage=… code=…[ reason=…] detail=…`. `detail` names the check that failed before the approval is read: `state_missing`, `state_invalid`, `state_expired`, `state_not_pending`, `tenant_missing` or `body_invalid`, and `none` otherwise. It appears only in the log; every such refusal gets the same `{ error: "unknown", code: "UNKNOWN" }` body, so a caller cannot probe whether a state is valid.

Neither the body nor the line includes callback input, delegations, tokens, session DIDs or node responses. The `403` `approval_owner_mismatch` response is unchanged.

`tinycloud.auth.import` now puts the activation rejection reason in `DELEGATION_REJECTED` error details as `details.reason`, for example `activation_rejected` when the node's `/delegate` refuses the delegation. Only `RuntimeDelegationRejectedError` reasons cross the result boundary.
