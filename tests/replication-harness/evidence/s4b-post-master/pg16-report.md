# Replication harness adhoc report

- Run: `tc893-s4b-post-master-pg16`
- Subject: `366d8f02ebcab3bf9fc298cd9dc8ca796628277d` (harness `366d8f02ebcab3bf9fc298cd9dc8ca796628277d`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: pg16

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-06[cli]@pg16 | pass | 17845.3 |  |
| CORE-06[sdk]@pg16 | pass | 4688.4 |  |
| CORE-07[cli]@pg16 | pass | 93434.1 |  |
| CORE-07[sdk]@pg16 | pass | 77091.4 |  |
| CORE-09[cli]@pg16 | pass | 17968.6 |  |
| CORE-09[sdk]@pg16 | pass | 4828.1 |  |
| CORE-10[cli]@pg16 | pass | 24208.3 |  |
| CORE-10[sdk]@pg16 | pass | 8763.1 |  |
| CORE-11[cli]@pg16 | pass | 22731.0 |  |
| CORE-11[sdk]@pg16 | pass | 5759.5 |  |
| CORE-08[cli]@pg16 | fail | 26859.5 | revoked prefix is absent or revoked and sentinel is purged — revoked prefix is absent or revoked and sentinel is purged: {"replicaDir":"[REDACTED_PATH]","report":{"exit":0,"json":{"since":"24h","totals":{"reads":2,"replicaReads":1,"hitRatio":0.5,"writes":0,"divergences":0},"readsBySourceReason":{"replica:hit":1,"network:stale":1},"latencyMs":{"replica":{"p50":156,"p95":156},"network":{"p50":145,"p95":145}},"stalenessMs":{"p50":39,"p95":39,"max":39},"syncs":{"none:ok":1,"node:GRANT_REVOKED":1},"writes":{},"divergences":[],"replicas":[{"prefix":"notes/","state":"idle","pending":{"inFlight":0,"committed":0,"ambiguous":0},"pinned":[],"lagMs":null}],"partitions":[{"idHash":"m6gwy553qxnmabpusqknd7dsrl","host":"[REDACTED]","space":"tinycloud:pkh:eip155:1:0xeb3018a3917c0d65f379c41935a48fc11581c725:default","pinned":0}]}},"residual":[]}; artefacts: `CORE-08_cli__pg16` |

## Metrics

