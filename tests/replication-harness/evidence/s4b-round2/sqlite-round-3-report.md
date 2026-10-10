# Replication harness adhoc report

- Run: `tc893-s4b-r2-final-sqlite-3`
- Subject: `c4426c968ba7a396f6981bcac3936c2564cea53b` (harness `c4426c968ba7a396f6981bcac3936c2564cea53b`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: sqlite

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-06[cli]@sqlite | pass | 15979.0 |  |
| CORE-06[sdk]@sqlite | pass | 2509.2 |  |
| CORE-07[cli]@sqlite | pass | 92562.1 |  |
| CORE-07[sdk]@sqlite | pass | 74884.7 |  |
| CORE-09[cli]@sqlite | pass | 17323.1 |  |
| CORE-09[sdk]@sqlite | pass | 2435.2 |  |
| CORE-10[cli]@sqlite | pass | 21570.7 |  |
| CORE-10[sdk]@sqlite | pass | 6199.1 |  |
| CORE-11[cli]@sqlite | pass | 20170.8 |  |
| CORE-11[sdk]@sqlite | pass | 3526.1 |  |
| CORE-08[cli]@sqlite | fail | 23405.6 | revoked prefix is absent or revoked and sentinel is purged — revoked prefix is absent or revoked and sentinel is purged: {"replicaDir":"[REDACTED_PATH]","report":{"exit":0,"json":{"since":"24h","totals":{"reads":2,"replicaReads":1,"hitRatio":0.5,"writes":0,"divergences":0},"readsBySourceReason":{"replica:hit":1,"network:stale":1},"latencyMs":{"replica":{"p50":152,"p95":152},"network":{"p50":167,"p95":167}},"stalenessMs":{"p50":41,"p95":41,"max":41},"syncs":{"none:ok":1,"node:GRANT_REVOKED":1},"writes":{},"divergences":[],"replicas":[{"prefix":"notes/","state":"idle","pending":{"inFlight":0,"committed":0,"ambiguous":0},"pinned":[],"lagMs":null}],"partitions":[{"idHash":"by4twuhaotyugnx5467vlsilyi","host":"[REDACTED]","space":"tinycloud:pkh:eip155:1:0x5a6cad0c89b85af3fbe95c3ba4a6ceca16ba7006:default","pinned":0}]}},"residual":[]}; artefacts: `CORE-08_cli__sqlite` |

## Metrics

