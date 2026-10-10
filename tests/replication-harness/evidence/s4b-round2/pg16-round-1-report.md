# Replication harness adhoc report

- Run: `tc893-s4b-r2-final-pg16-1`
- Subject: `c4426c968ba7a396f6981bcac3936c2564cea53b` (harness `c4426c968ba7a396f6981bcac3936c2564cea53b`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: pg16

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-06[cli]@pg16 | pass | 18075.5 |  |
| CORE-06[sdk]@pg16 | pass | 4675.1 |  |
| CORE-07[cli]@pg16 | pass | 94145.7 |  |
| CORE-07[sdk]@pg16 | pass | 77053.3 |  |
| CORE-09[cli]@pg16 | pass | 17237.1 |  |
| CORE-09[sdk]@pg16 | pass | 4900.0 |  |
| CORE-10[cli]@pg16 | pass | 23733.4 |  |
| CORE-10[sdk]@pg16 | pass | 8845.4 |  |
| CORE-11[cli]@pg16 | pass | 22500.0 |  |
| CORE-11[sdk]@pg16 | pass | 5696.0 |  |
| CORE-08[cli]@pg16 | fail | 25896.8 | revoked prefix is absent or revoked and sentinel is purged — revoked prefix is absent or revoked and sentinel is purged: {"replicaDir":"[REDACTED_PATH]","report":{"exit":0,"json":{"since":"24h","totals":{"reads":2,"replicaReads":1,"hitRatio":0.5,"writes":0,"divergences":0},"readsBySourceReason":{"replica:hit":1,"network:stale":1},"latencyMs":{"replica":{"p50":159,"p95":159},"network":{"p50":105,"p95":105}},"stalenessMs":{"p50":43,"p95":43,"max":43},"syncs":{"none:ok":1,"node:GRANT_REVOKED":1},"writes":{},"divergences":[],"replicas":[{"prefix":"notes/","state":"idle","pending":{"inFlight":0,"committed":0,"ambiguous":0},"pinned":[],"lagMs":null}],"partitions":[{"idHash":"dkhm2nzws7gkynmeix6kgo72xx","host":"[REDACTED]","space":"tinycloud:pkh:eip155:1:0xa3f952b6ba0771e77abab6670f57dce7b787e00b:default","pinned":0}]}},"residual":[]}; artefacts: `CORE-08_cli__pg16` |

## Metrics

