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
- proves a peer-serving hop from `node-b` into `node-c`

### KV Offline / Provisional

- authors KV state on a disconnected replica
- reads provisional local state before canonical commit arrives
- later observes converged canonical state on all nodes

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
    ├── auth-session.test.ts
    ├── helpers.ts
    ├── kv-baseline.test.ts
    ├── kv-delete-reconcile.test.ts
    ├── kv-offline-provisional.test.ts
    ├── kv-peer-serving-reconcile.test.ts
    ├── kv-reconcile.test.ts
    ├── kv-restart-catchup.test.ts
    ├── sql-baseline.test.ts
    ├── sql-reconcile.test.ts
    ├── sql-schema-drift.test.ts
    ├── delegation-baseline.test.ts
    └── smoke.test.ts
```

Later stages should add:

- `auth-recovery.test.ts` for full auth-sync and recovery semantics beyond session gating

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
