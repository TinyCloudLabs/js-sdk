---
"@tinycloud/cli": patch
"@tinycloud/operations": minor
"@tinycloud/mcp": patch
---

Unify stored-grant replay across CLI, operations, and MCP. Refused replay candidates use fixed-code warnings; cross-user imports addressed to another key remain separate and silent.

Breaking behavior for `@tinycloud/cli`:
- Grants without a `siweProof` (including CLI <=1.1.0-beta.13 and 1.0.x escalations and non-compact imports without proof) are refused with `proof_missing`. Owners can approve again using `tc auth request --grant [--device]`; delegates can request, receive, and import a new signed grant or reimport the original artifact with its proof. Remove stale rows using `tc auth grants remove <old-cid>`; an owner may add `--revoke`.
- Unbound compact grants no longer install before migration binds them (including a busy migration lock, `--private-key` on a local profile, or a session without `verificationMethod`); they report `unbound`. Run an ordinary command, sign in again, or reimport the artifact to recover.
- Compact grants with invalid signatures or CIDs are refused locally with `proof_invalid` before a node request, rather than `activation_rejected` or a silent skip. `Bearer`-prefixed authorizations are stripped before activation so verified grants also authorize reads.
- `tc auth import` refuses a session-addressed non-compact delegation without proof (`INVALID_AUTH_IMPORT`, exit 2), or a signed-login delegation failing verification (`DELEGATION_REJECTED`, exit 1). Valid imports bind to `unbound-import:<cid>`.
- Commands that replay may now emit a `{warnings}` stderr line or include `error.warnings`; `TC_DEBUG_REPLAY` is removed. `--private-key` on an OpenKey profile no longer replays stored grants.
- Owner OpenKey `tc delegation revoke` no longer requests raw `urn:cid` authority (unsupported by deployed OpenKey). It uses a CID-bound owner-space fallback, or fails immediately with `RAW_RECAP_RESOURCE_UNSUPPORTED` instead of timing out.

Breaking behavior for `@tinycloud/operations`:
- `replayLimit(entry)` no longer takes `migrated` or returns `"signed"`; `replayStoredDelegation` options no longer take `migrated`; `activateUnboundCompactImport` becomes `activateUnboundImport` and accepts signed-login records. New APIs: `replayProfileDelegations`, `inspectStoredDelegation`, `storedDelegationForAnotherKey`, `storedDelegationSource`, and `withoutBearer`.
- Unbound compact grants are refused before migration; `createInvocationRuntime` replays only for a restored persisted session. `liveAdditionalDelegationCount` in `tinycloud.status.get` and `tinycloud.auth.status` counts only bound, unexpired grants. Invalid compact proofs report `proof_invalid`. `generated/operations.json` changes accordingly.

`@tinycloud/mcp` receives the shared replay and status behavior through its `@tinycloud/operations` dependency; no MCP-generated schema changes in this release.
