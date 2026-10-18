# Shared share index (`@tinycloud/share-sdk/share-index`, TC-1432)

Reference for adopters (share web, `tc share`, migration) of the share index added in TC-1432 slice 2. Design: TC-1432 design C v3.2.

## Layout
In the `applications` space, under the vault prefix `sender-history/v2/records/`:

| Key | Writer | Content |
|---|---|---|
| `<shareId>` | owner clients (web, owner-key CLI) | web record, owner-network vault envelope |
| `<shareId>` with `provenance: "migrated"` | the owner's session, once, during migration | imported CLI record (shown as "imported") |
| `agents/<agentId>/<shareId>` | that agent (Tier W) | double-wrapped agent record; untrusted input |
| `_index/main`, `_index/archive-<yyyy>` | owner clients, Tier 2 | encrypted display-only index |

`agentId` = `agentIdFromDid(agentDid)`. Agents list with the explicit prefix and its trailing slash (`agentRecordPrefix`); a list without the slash is refused by the node.

## Pieces
- `classifyRecordKey`, `isShareId`: run on every listed key before anything else.
- `WebShareRecordStore`, `AgentShareRecordStore`: `SenderShareRecordStorage` over a `ShareIndexBackend` (`createTinyCloudShareIndexBackend({ client, spaceId, ownerNetworkId, decryptProof })`). Tier W agents omit `decryptProof`.
- `deriveAgentKeyMaterial(privateKeyBytes, agentDid)`: KEK_a from the key the agent signs with. Without a local private key the record is owner-readable only.
- `SenderShareIndex`: `load`, `enqueue` + `flush` (outbox ops, CAS), `reconcile`, `syncStatus`, `compact`. Inject sdk-core `parseSignedSiweCacao` as `parseSiweCacao`, and the node registration key lookup (`registrationKey(nodeAudience)`) once the share public config carries it.
- `verifyAgentRecordChain`: re-run it on the freshly decrypted record before any row action (§6).
- Import everything from the subpath `@tinycloud/share-sdk/share-index`. The package root does not re-export it, so browser bundles that only use the root stay small.

## Rules adopters rely on
- **Record size**: an agent record is refused above `MAX_AGENT_RECORD_BYTES` (32 KiB, inclusive bound). A real CLI bearer record with its link and full chain is about 17 KiB.
- **Spaces**: records live in the owner's `applications` space; a record's content (`target.spaceId`) may be any space of the account owner (the CLI uses `default`).
- **registeredAt** is checked against signed times in the chain, never against when the owner first loads Share:
  - within a day of a signed issuance time: the link UCAN's `nbf`, the v3 enforcer binding's `issuedAt`, or the node-signed v2 `registeredAt`;
  - for WASM-issued links, which carry no `nbf`: not more than a day before the session's signed `Issued At`, and not after the link's expiry;
  - never more than 5 minutes in the future.
- **Proof states**: `proven` (chain to the owner, leaf issued by this agent), `chained` (chain to the owner through another key), `unproven` (no owner→session CACAO). `pe: true` marks a verified chain that has expired. Precedence: web > proven > chained > unproven, in any arrival order.
- **Per pass**: at most 10 list pages and 200 fetches; every fetch of an agent's record, whatever its verdict, spends that agent's 50-per-pass allowance.
- **Header cap** (64 KiB): when the reconciler's findings would grow the header past it, the pass still lands rows but adds no new agent state, and reports `headerFull: true` for an alert. The owner's own ops are never blocked by it, and no row is ever evicted for it. `rejectedKeys`/`newerKeys` entries are 16-character hashes, never agent-chosen text.
- **Migrated provenance** (`pv: "migrated"`, written by the migration in slice 5):
  - It is exempt from the ±1-day `registeredAt` anchor and from nothing else: it may not postdate its chain or the clock, and the schema, link and chain checks all apply. It is never `proven`.
  - It ranks by its proof state, never as a web row. It never displaces a row whose revocation the node confirmed.
  - An import that fails a check, or loses a claim, is kept as a claimless needs-attention row.
  - Revoke still verifies the CID with the node.
  - A record inside `agents/<id>/` that claims `migrated` is rejected (`provenance`) and counted against that agent.
- **CAS**:
  - `INVALID_ETAG`, for example an ETag weakened to `W/"…"` in transit, throws `ShareIndexCasError` (`code: "INVALID_ETAG"`) with the SDK's message on the first occurrence. It is never retried, and pending ops stay in the outbox. Show the message to the user.
  - `ETAG_MISMATCH` and `NODE_BUSY` back off, for at most 6 attempts, then throw `EXHAUSTED`.
  - `OUTCOME_UNKNOWN` re-reads and decides; it never re-puts blindly.
- **Revoking an agent's shares** (observed on a local node, slice 2):
  - One share: the owner wallet revokes the share's CIDs through the generic `/revoke` route. For a bearer row that is the link delegation CID; for a Policy/v3 row, the `policyRoot` and `enforcementRoot` CIDs from the signed envelope (200; an open recipient session's next read gets 403 `root-revoked`). Only the JSON root-revocation route refuses the owner (403 `root-revocation-issuer-invalid`).
  - Everything from one agent session: revoking the owner→session delegation kills that session's bearer links and fails new v3 claims at once, but a v3 recipient session that is already open keeps reading for its lifetime (3,598 s observed). The node liveness check (N3, test B-1) closes that.
  - Revoke dialogs must say this rather than promise that a session-wide revoke cuts off open recipients immediately.
