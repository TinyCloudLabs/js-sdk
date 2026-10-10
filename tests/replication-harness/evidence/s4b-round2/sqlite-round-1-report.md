# Replication harness adhoc report

- Run: `tc893-s4b-r2-final-sqlite-1`
- Subject: `c4426c968ba7a396f6981bcac3936c2564cea53b` (harness `c4426c968ba7a396f6981bcac3936c2564cea53b`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: sqlite

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-06[cli]@sqlite | pass | 15761.1 |  |
| CORE-06[sdk]@sqlite | pass | 2466.4 |  |
| CORE-07[cli]@sqlite | pass | 92415.0 |  |
| CORE-07[sdk]@sqlite | pass | 74889.4 |  |
| CORE-09[cli]@sqlite | pass | 14977.0 |  |
| CORE-09[sdk]@sqlite | pass | 2309.5 |  |
| CORE-10[cli]@sqlite | pass | 21889.5 |  |
| CORE-10[sdk]@sqlite | pass | 6433.6 |  |
| CORE-11[cli]@sqlite | pass | 20424.0 |  |
| CORE-11[sdk]@sqlite | pass | 3527.1 |  |
| CORE-08[cli]@sqlite | fail | 23651.8 | revoked prefix is absent or revoked and sentinel is purged — revoked prefix is absent or revoked and sentinel is purged: {"replicaDir":"[REDACTED_PATH]","report":{"exit":0,"json":{"since":"24h","totals":{"reads":2,"replicaReads":1,"hitRatio":0.5,"writes":0,"divergences":0},"readsBySourceReason":{"replica:hit":1,"network:stale":1},"latencyMs":{"replica":{"p50":152,"p95":152},"network":{"p50":172,"p95":172}},"stalenessMs":{"p50":42,"p95":42,"max":42},"syncs":{"none:ok":1,"node:GRANT_REVOKED":1},"writes":{},"divergences":[],"replicas":[{"prefix":"notes/","state":"idle","pending":{"inFlight":0,"committed":0,"ambiguous":0},"pinned":[],"lagMs":null}],"partitions":[{"idHash":"34f54bk3efyc4l5rpxavjw35lv","host":"[REDACTED]","space":"tinycloud:pkh:eip155:1:0xfbf7eafd2ebf0451ba051fa5ab7b2b61dfb689a2:default","pinned":0}]}},"residual":[]}; artefacts: `CORE-08_cli__sqlite` |

## Metrics

