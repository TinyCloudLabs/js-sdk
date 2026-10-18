---
"@tinycloud/share-sdk": minor
"@tinycloud/share-envelope": patch
"@tinycloud/sdk-core": patch
---

Shared share index, SDK layer (TC-1432 design C, slice 2). Additive; nothing existing changes behaviour.

- Record store: `WebShareRecordStore` (`records/<shareId>`, owner-network vault) and `AgentShareRecordStore` (`records/agents/<agentId>/<shareId>`), both `SenderShareRecordStorage`. `isShareId` is enforced on every operation; agent lists use the explicit prefix with its trailing slash.
- Key classifier `classifyRecordKey`: rejects `%`, `\`, `.`/`..` and empty segments and a leading `/` before anything else; a rejected key inside an agent prefix is charged to that agent once.
- Agent record codec: a fresh 32-byte data key and fresh nonces on every write, HKDF subkeys bound to the record location, a key commitment checked in constant time, and two wraps of the data key (`wrapAgent` under a key derived from the agent's signing key, `wrapOwner` to the owner network). The owner path refuses an owner wrap whose declared AAD is not the record's binding before any decrypt request, and zeroes the data key on every path.
- Chain verifier `verifyAgentRecordChain` (bearer link delegations, Policy/v3 envelopes, Policy/v2 owner policies) with proof states `proven` / `chained` / `unproven` and a separate `expired` flag; precedence web > proven > chained > unproven in any arrival order (`decideClaim`). New verifiers: signed UCAN parsing with `prf`/`nbf`/`exp`, attenuation containment, owner→session SIWE checks (time window, issuer = account owner, audience = delegation issuer), a Policy/v2 enforcement-delegation signature verifier, and `checkOwnerSharePolicyRegistration`, which reports an expired registration as `expired` instead of throwing.
- `SenderShareIndex`: the encrypted display-only index at `records/_index/main` with compare-and-swap writes, an outbox interface, the budgeted reconciler with the §5 checks, per-agent rejected lists, caps and pause, status sync, compaction into `records/_index/archive-<yyyy>` and header garbage collection. A refused ETag (`INVALID_ETAG`, for example one weakened in transit) throws `ShareIndexCasError` on its first occurrence and is never retried.
- share-envelope: `verifyEnvelopeV3` accepts an optional `now` for the enforcer-binding window.
- sdk-core: `parseSignedSiweCacao` also returns the signed `notBefore`.
