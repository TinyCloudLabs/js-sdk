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

## Owner-side record admission

The public `@tinycloud/share-sdk/share-index` entry exports the existing `checkAgentRecordSchema`, `AgentRecordSchemaContext` type and `registeredAtFits` helpers used by `SenderShareIndex`.

- `checkAgentRecordSchema(value, context)` accepts an unknown decrypted value and returns a `StoredShareRecord`, or throws `ShareRecordSchemaError`. Supply the supported header `recordV`, share ID from the classified key, authenticated `accountOwnerDid`, header `agentDid` and layout-derived `source` (`agent` or `migrated`) through `AgentRecordSchemaContext`. The helper checks the existing record schema, provenance, identity and owner-space rules.
- Before schema checking, bound the raw transfer with `readRaw(key, MAX_AGENT_RECORD_BYTES)`, validate the stored header and derived agent path, and open that same snapshot with `openAgentRecordAsOwner`. The owner codec checks the owner network, path/AAD binding, commitment and ciphertext.
- After schema checking, call `restoreShareRecordLink(record, shareOrigins)` with the configured renderer origins, then validate the resulting link and material with `validateShareLink` and `assertLinkBoundToMaterial`. Run `verifyAgentRecordChain` with the actual signed-SIWE parser and authenticated owner context, and apply `registeredAtFits(record.registeredAt, window, now)` using the verified chain's signed-time window and existing source-specific rules. Schema validation alone does not verify signatures or establish a chain to the owner. Addressed artifact records also use `verifyArtifactShare` for the signed pin/source binding, as the sender index does.
- Open, Copy and Revoke repeat these checks on a fresh bounded snapshot; the display-only index is not an action record. Management also binds the active account and chain, node origin/audience, original signed root CID/role and exact resources to the node's granted/root evidence.

Readback expansion is separate from owner admission: `expandShareRecord(record, { shareOrigins })` restores material and the original link; the owner still applies the full chain, time and action checks above.

Details: TC-1739

## Rules adopters rely on
- **Record size**: an agent record is refused above `MAX_AGENT_RECORD_BYTES` (32 KiB, inclusive bound). Measured on a local node: a real CLI bearer record with its link and full chain is 16,938 B stored; a real CLI Policy/v3 record in its stored form (below) is 29,518 B stored (21,063 B plaintext, 3,250 B under the cap; it was 46,803 B plaintext before). Its size grows with the session CACAO (7,448 B, the ReCap of the session manifest) and the policy.
- **Stored form: each blob once** (`compactShareRecord`, applied by `AgentShareRecordStore.put`): a Policy/v3 record keeps `deliveryMaterial.{shareCid, sealedEnvelope, envelopeKey}` and its session CACAO, and omits `deliveryMaterial.envelope` (what `sealedEnvelope` decrypts to), after checking it is exactly what the sealed material opens to. The reconciler refuses an agent record that stores it again (`schema`).
  - The verifier opens the envelope from the sealed material (`openDeliveryEnvelope`: CID == `shareCid`, opens under `envelopeKey`, canonical JSON) and binds the record's `shareCid`/`envelopeCid` to it.
  - Short `v=4` links stay verbatim: their original short ID is not derivable. `assertLinkBoundToMaterial` checks the key and sealed-body CID.
  - A full link stores only `deliveryMaterial.fullLink: { origin, header, signature }` beside the required three string fields. `header` and `signature` retain the original public links types and strict validators; `origin` is the original renderer origin, separate from the Node origin and the links API audience. The sealed body is stored once. `buildFullLink` reconstructs the exact original full URL without generating or re-signing any field.
  - Original wrapper verification uses the public link-record checks, including the sealed body's original signer. History checks it at the signed header's issuance time and binds its expiry to the inner envelope and record; current-time chain verification still reports genuine expired history as Expired. Recipient opening retains its ordinary current-time expiry checks.
  - Existing three-field material remains readable. Without the original wrapper, an absent full link stays absent; no short ID or signed wrapper is invented. Strict older readers need the updated SDK to read metadata-bearing records.
  - `expandShareRecord(record)` restores the envelope and available original link for agent readback or delivery retry. Owner callers provide configured `shareOrigins` and perform the full admission pipeline above.
  - Details: TC-1739
- **Transfer bound**: the node accepts KV values far larger than the cap (request bodies up to 95 MiB). The adapter's `readRaw(key, maxBytes)` sends the cap as the KV `maxResponseBytes` (`x-tinycloud-max-response-bytes`): the node refuses a larger value with 413 (`KV_RESPONSE_TOO_LARGE`) before sending its body, reported as `too_large`; the body length is checked again after a fetch. (A KV HEAD does not help: the node's metadata response carries no object size.) The reconciler passes the cap, so an oversize value costs one refused request. Slice 3's browser transport must keep this property: the cap on the request (or a streamed read that aborts at the cap), never a buffered GET of an unknown size.
- **Spaces**: records live in the owner's `applications` space; a record's content (`target.spaceId`) may be any space of the account owner (the CLI uses `default`).
- **Artifact content**: `parseArtifactVersionPath` supplies the existing canonical `artifacts/<id>/versions/<positive version>/<one filename>` grammar. Agent records use exact read-only files, not prefixes, traversal paths or a `files/` segment. Native chains bind the actual UCAN source; V3 addressed chains retain the signed artifact pin/version/source checks through `verifyArtifactShare`, independently of recipient metadata. Legacy V2 policy proofs do not admit artifact records. Details: TC-1739
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
- **Agent grants** (slice 4): `createDelegation({ disableSubDelegation: true })` makes a grant terminal (TC-1436), and wallet-mode `useDelegation` to a did:pkh recipient cannot build on it: it sub-delegates to its session key, which the node refuses (401 `terminal-parent-cannot-redelegate`). The CLI activates its Tier W grant through runtime permissions (`grantRuntimePermissions`, as live test h does) or receives the grant at its session-key DID directly; never wallet-mode `useDelegation` on a terminal grant. Refusing such grants up front in the SDK is TC-1448.
- **CAS**:
  - `INVALID_ETAG`, for example an ETag weakened to `W/"…"` in transit, throws `ShareIndexCasError` (`code: "INVALID_ETAG"`) with the SDK's message on the first occurrence. It is never retried, and pending ops stay in the outbox. Show the message to the user.
  - `ETAG_MISMATCH` and `NODE_BUSY` back off, for at most 6 attempts, then throw `EXHAUSTED`.
  - `OUTCOME_UNKNOWN` re-reads and decides; it never re-puts blindly.
- **Revoking an agent's shares** (observed on a local node, slice 2):
  - One share: the owner wallet revokes the share's CIDs through the generic `/revoke` route. For a bearer row that is the link delegation CID; for a Policy/v3 row, the `policyRoot` and `enforcementRoot` CIDs from the signed envelope (200; an open recipient session's next read gets 403 `root-revoked`). Only the JSON root-revocation route refuses the owner (403 `root-revocation-issuer-invalid`).
  - Everything from one agent session: revoking the owner→session delegation kills that session's bearer links and fails new v3 claims at once, but a v3 recipient session that is already open keeps reading for its lifetime (3,598 s observed). The node liveness check (N3, test B-1) closes that.
  - Revoke dialogs must say this rather than promise that a session-wide revoke cuts off open recipients immediately.
