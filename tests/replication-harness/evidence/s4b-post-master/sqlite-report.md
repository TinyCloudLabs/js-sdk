# Replication harness adhoc report

- Run: `tc893-s4b-post-master-sqlite`
- Subject: `366d8f02ebcab3bf9fc298cd9dc8ca796628277d` (harness `366d8f02ebcab3bf9fc298cd9dc8ca796628277d`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: sqlite

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-06[cli]@sqlite | pass | 15620.6 |  |
| CORE-06[sdk]@sqlite | pass | 2606.4 |  |
| CORE-07[cli]@sqlite | pass | 92193.1 |  |
| CORE-07[sdk]@sqlite | pass | 75092.0 |  |
| CORE-09[cli]@sqlite | pass | 15457.3 |  |
| CORE-09[sdk]@sqlite | pass | 2390.2 |  |
| CORE-10[cli]@sqlite | pass | 21582.9 |  |
| CORE-10[sdk]@sqlite | pass | 6419.0 |  |
| CORE-11[cli]@sqlite | pass | 20163.9 |  |
| CORE-11[sdk]@sqlite | pass | 3462.8 |  |
| CORE-08[cli]@sqlite | fail | 24168.2 | revoked prefix is absent or revoked and sentinel is purged — revoked prefix is absent or revoked and sentinel is purged: {"replicaDir":"[REDACTED_PATH]","report":{"exit":0,"json":{"since":"24h","totals":{"reads":2,"replicaReads":1,"hitRatio":0.5,"writes":0,"divergences":0},"readsBySourceReason":{"replica:hit":1,"network:stale":1},"latencyMs":{"replica":{"p50":153,"p95":153},"network":{"p50":121,"p95":121}},"stalenessMs":{"p50":39,"p95":39,"max":39},"syncs":{"none:ok":1,"node:GRANT_REVOKED":1},"writes":{},"divergences":[],"replicas":[{"prefix":"notes/","state":"idle","pending":{"inFlight":0,"committed":0,"ambiguous":0},"pinned":[],"lagMs":null}],"partitions":[{"idHash":"qgq2xpcrzkznoesiyuoflczrwj","host":"[REDACTED]","space":"tinycloud:pkh:eip155:1:0x843a7f45d468db7e7e2490f5599371e102c2632a:default","pinned":0}]}},"residual":[]}; artefacts: `CORE-08_cli__sqlite` |

## Metrics

