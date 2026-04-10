# Replication E2E Test Specification

**Status:** Draft
**Runner:** `bun test`

---

## Goal

Drive replication end-to-end through the real `@tinycloud/node-sdk` client against multiple live `tinycloud-node` processes.

This suite complements the existing single-node SQL and DuckDB tests. It does not replace them.

No replication test in this suite may use mocked transport, mocked node responses, or fake replication state.
If a scenario cannot be exercised against live nodes yet, it should stay unimplemented or be captured as a blocker rather than replaced with a mock.

---

## Stage 0 Scenarios

### Cluster Smoke

- boots `node-a`, `node-b`, and `node-c`
- reaches `/info` and `/healthz` on all three nodes
- signs the same Alice identity into `node-a` and `node-b`
- observes the same `spaceId` across those hosts for the same key and prefix

### KV Canonical Replication

- writes a KV value through `node-a`
- waits for the value to appear through `node-b`
- proves catch-up still works after a temporary disconnect and restart
- proves a host peer-serving hop from `node-b` into `node-c`
- proves replica peer-serving is denied by default and only enabled when explicitly opted in

### KV Recon Inventory Export

- exports scoped KV inventory through an authenticated `recon/export` endpoint
- proves the same scoped inventory matches after replay reconcile on both nodes
- proves sibling prefixes do not leak into the scoped inventory

### KV Recon Compare

- compares scoped KV state through an authenticated `recon/compare` endpoint
- proves mismatch before replay reconcile and match after reconcile
- proves sibling prefixes remain isolated when compare is run on a narrower prefix

### KV Recon Split

- summarizes immediate KV child scopes through an authenticated `recon/split` endpoint
- proves a partial replay reconcile can make one child prefix match while another remains missing
- proves the root split summary converges after both child prefixes are replayed

### KV Recon Split Compare

- compares immediate KV child scopes through an authenticated `recon/split/compare` endpoint
- proves a partial replay reconcile marks one child prefix as `match` while another remains `local-missing`
- proves the root split comparison converges to all `match` after the remaining child prefix is replayed

### KV Split-Driven Replay

- replays only the missing immediate child scopes through an authenticated `reconcile/split` endpoint
- pages missing child scopes through `childLimit: 1`, proving one child is repaired per pass and the root only converges after the second pass
- proves a broad-scope reconcile skips an already-matched child prefix and repairs only the remaining missing child prefix
- proves root split comparison converges after the selective replay

### KV Split-Driven Reconcile Pagination

- pages child-level replay on `reconcile/split` with `childStartAfter` and `childLimit`
- proves a wide root child set can be repaired across multiple paged reconcile calls
- proves peer-missing child semantics remain unchanged while local-missing children are replayed

### KV Split-Driven Grandchild Replay

- descends from a broad root scope into a deeper mismatched grandchild prefix under one coarse child via `maxDepth: 2`
- pages grandchild children with `childLimit: 1` so only one nested child is repaired per pass
- proves the coarse child and root remain mismatched until the remaining grandchild is replayed

### KV Split Child Pagination

- pages wide child lists on `recon/split` and `recon/split/compare` with `childStartAfter` and `childLimit`
- proves `hasMore` and `nextChildStartAfter` advance deterministically across child-page boundaries
- proves both split surfaces traverse the same child ordering across repeated requests

### KV Recon Bounded Windows

- pages scoped KV inventory through authenticated `recon/export` and `recon/compare` with `startAfter` and `limit`
- proves a reconciled primary scope can be traversed page by page until the cursor is exhausted
- proves sibling prefixes remain isolated across page boundaries

### KV Offline / Provisional

- authors KV state on a disconnected replica
- reads provisional local state before canonical commit arrives
- later observes converged canonical state on all nodes

### KV State Proof

- distinguishes a present KV key from a deleted key and an absent key through an authenticated `kv/state` endpoint
- proves a peer can ask the authority host for key state after partial reconciliation
- keeps deleted-key status distinct from never-seen-key status

### KV State Compare

- compares local KV state against a peer through an authenticated `kv/state/compare` endpoint
- proves a present key reports `peerStatus: present`
- proves a key deleted on the peer but still locally visible reports `peerStatus: deleted`
- proves a local-only key reports `peerStatus: absent`

### Peer-Missing Planning

- builds an authenticated action plan for `peer-missing` KV divergence
- rejects authority-mode planning against a peer-serving replica that is not a host
- classifies peer-visible deletes as `prune-delete`
- classifies bare peer absence as `quarantine-absent`
- keeps still-present peer keys as `keep`

### Peer-Missing Apply

- applies only delete-backed `peer-missing` actions from explicit tombstone evidence
- persists bare peer absence as quarantine records rather than deleting local data
- proves a second apply reports already-quarantined local-only keys
- proves local-only data remains visible after apply

### SQLite Canonical Replication

- creates a replicated table with an explicit primary key
- inserts, updates, and deletes rows through the authority host
- observes converged query-visible state through another node

### SQLite Schema Drift

- applies divergent local schema/state on one node
- reconciles from the authority host
- observes authority snapshot override of the local drift

### Auth / Recovery

- requires a replication session handshake before export begins
- surfaces a per-space `serverDid` from `replication/session/open` for session identity checks
- surfaces per-space serving assessment fields from `replication/session/open` for `canExport` and role checks
- opens a replication session on a first-contact peer by carrying the supporting delegation chain
- invalidates a replication transport session after its sync delegation is revoked
- blocks unauthenticated export and reconcile pull-through
- preserves local authored facts during authority outage
- resumes convergence after reconnect

---

## Initial File Layout

```text
tests/node-sdk/
├── REPLICATION-E2E-SPEC.md
├── setup.ts
└── replication/
    ├── cluster.ts
    ├── auth-revocation.test.ts
    ├── auth-session.test.ts
    ├── auth-first-contact.test.ts
    ├── auth-recovery.test.ts
    ├── helpers.ts
    ├── auth-session-serverdid.test.ts
    ├── auth-session-serving-assessment.test.ts
    ├── kv-baseline.test.ts
    ├── kv-delete-reconcile.test.ts
    ├── kv-offline-provisional.test.ts
    ├── kv-peer-serving-enforcement.test.ts
    ├── kv-peer-serving-reconcile.test.ts
    ├── kv-peer-missing-apply.test.ts
    ├── kv-peer-missing-plan.test.ts
    ├── kv-state.test.ts
    ├── kv-state-compare.test.ts
    ├── kv-recon-compare.test.ts
    ├── kv-reconcile.test.ts
    ├── kv-restart-catchup.test.ts
    ├── kv-recon-export.test.ts
    ├── kv-recon-split-compare.test.ts
    ├── kv-recon-split-reconcile.test.ts
    ├── kv-recon-split-grandchild.test.ts
    ├── kv-recon-split-pagination.test.ts
    ├── kv-recon-split-reconcile-pagination.test.ts
    ├── kv-recon-split.test.ts
    ├── kv-recon-window.test.ts
    ├── sql-baseline.test.ts
    ├── sql-reconcile.test.ts
    ├── sql-schema-drift.test.ts
    ├── delegation-baseline.test.ts
    └── smoke.test.ts
```

Later stages should add:

- `auth-recovery-propagation.test.ts` for broader auth-fact replay and recovery semantics beyond session gating

---

## Test Conventions

- Use one deterministic Alice key across hosts when proving same-space behavior.
- Use unique prefixes and DB names per test case.
- Prefer public SDK-visible assertions over internal state inspection.
- Keep the first suite local and process-based, not Docker-required.

---

## Exit Criteria

The Stage 0 spec is satisfied when:

- the cluster harness exists,
- the smoke test passes,
- and later replication tests can reuse the same helpers instead of inventing a second harness.
