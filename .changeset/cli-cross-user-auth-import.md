---
"@tinycloud/cli": patch
---

Fix `tc auth import` rejecting cross-user delegations. Import unconditionally called `node.useRuntimeDelegation(...)`, which requires the delegation to target the active session key and so threw `Runtime delegation targets did:pkh:... but this session key is did:key:...` for a delegation received from another user (audience = your stable identity DID). Import now routes by audience: a delegation that targets the active session key is still installed as a runtime grant, while a cross-user delegation is persisted to `additional-delegations.json` and later activated at read time via `node.useDelegation(...)`. The `imported` output now includes an `activated` flag indicating whether a runtime grant was installed.
