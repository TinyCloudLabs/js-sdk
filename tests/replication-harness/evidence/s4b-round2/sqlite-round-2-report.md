# Replication harness adhoc report

- Run: `tc893-s4b-r2-final-sqlite-2`
- Subject: `c4426c968ba7a396f6981bcac3936c2564cea53b` (harness `c4426c968ba7a396f6981bcac3936c2564cea53b`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: sqlite

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-06[cli]@sqlite | pass | 15487.0 |  |
| CORE-06[sdk]@sqlite | pass | 2641.1 |  |
| CORE-07[cli]@sqlite | pass | 92145.8 |  |
| CORE-07[sdk]@sqlite | pass | 75115.7 |  |
| CORE-09[cli]@sqlite | pass | 15888.4 |  |
| CORE-09[sdk]@sqlite | pass | 5439.2 |  |
| CORE-10[cli]@sqlite | pass | 22328.0 |  |
| CORE-10[sdk]@sqlite | pass | 6744.7 |  |
| CORE-11[cli]@sqlite | pass | 20425.2 |  |
| CORE-11[sdk]@sqlite | pass | 3732.0 |  |
| CORE-08[cli]@sqlite | fail | 23838.9 | revoked prefix is absent or revoked and sentinel is purged — revoked prefix is absent or revoked and sentinel is purged: {"replicaDir":"[REDACTED_PATH]","report":{"exit":0,"json":{"since":"24h","totals":{"reads":2,"replicaReads":1,"hitRatio":0.5,"writes":0,"divergences":0},"readsBySourceReason":{"replica:hit":1,"network:stale":1},"latencyMs":{"replica":{"p50":149,"p95":149},"network":{"p50":119,"p95":119}},"stalenessMs":{"p50":37,"p95":37,"max":37},"syncs":{"none:ok":1,"node:GRANT_REVOKED":1},"writes":{},"divergences":[],"replicas":[{"prefix":"notes/","state":"idle","pending":{"inFlight":0,"committed":0,"ambiguous":0},"pinned":[],"lagMs":null}],"partitions":[{"idHash":"ltk2yblf6vdyu34k6ykmmdgytj","host":"[REDACTED]","space":"tinycloud:pkh:eip155:1:0x5927a30c03455588f2ed3fa3dbc96aa819a7413e:default","pinned":0}]}},"residual":[]}; artefacts: `CORE-08_cli__sqlite` |

## Metrics

