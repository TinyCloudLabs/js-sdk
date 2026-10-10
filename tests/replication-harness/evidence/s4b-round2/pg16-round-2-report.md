# Replication harness adhoc report

- Run: `tc893-s4b-r2-final-pg16-2`
- Subject: `c4426c968ba7a396f6981bcac3936c2564cea53b` (harness `c4426c968ba7a396f6981bcac3936c2564cea53b`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: pg16

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-06[cli]@pg16 | pass | 18169.3 |  |
| CORE-06[sdk]@pg16 | pass | 4726.4 |  |
| CORE-07[cli]@pg16 | pass | 93750.0 |  |
| CORE-07[sdk]@pg16 | pass | 77092.6 |  |
| CORE-09[cli]@pg16 | pass | 17471.5 |  |
| CORE-09[sdk]@pg16 | pass | 4657.4 |  |
| CORE-10[cli]@pg16 | pass | 24137.4 |  |
| CORE-10[sdk]@pg16 | pass | 8853.4 |  |
| CORE-11[cli]@pg16 | pass | 22898.9 |  |
| CORE-11[sdk]@pg16 | pass | 5716.9 |  |
| CORE-08[cli]@pg16 | fail | 25722.1 | revoked prefix is absent or revoked and sentinel is purged — revoked prefix is absent or revoked and sentinel is purged: {"replicaDir":"[REDACTED_PATH]","report":{"exit":0,"json":{"since":"24h","totals":{"reads":2,"replicaReads":1,"hitRatio":0.5,"writes":0,"divergences":0},"readsBySourceReason":{"replica:hit":1,"network:stale":1},"latencyMs":{"replica":{"p50":160,"p95":160},"network":{"p50":115,"p95":115}},"stalenessMs":{"p50":47,"p95":47,"max":47},"syncs":{"none:ok":1,"node:GRANT_REVOKED":1},"writes":{},"divergences":[],"replicas":[{"prefix":"notes/","state":"idle","pending":{"inFlight":0,"committed":0,"ambiguous":0},"pinned":[],"lagMs":null}],"partitions":[{"idHash":"h2gdnlewoxppxq7nwwa5gmt5tp","host":"[REDACTED]","space":"tinycloud:pkh:eip155:1:0xe28f045f656abd6aa6ac85aed35d88b38ceb6432:default","pinned":0}]}},"residual":[]}; artefacts: `CORE-08_cli__pg16` |

## Metrics

