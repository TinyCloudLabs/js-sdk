# Replication harness adhoc report

- Run: `s4a-final-sqlite-1`
- Subject: `878d7ac9451c8f6d3f98ebe45e149a8ea2b599ae` (harness `878d7ac9451c8f6d3f98ebe45e149a8ea2b599ae`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: sqlite

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-00@sqlite | pass | 7019.3 |  |
| CORE-01[sdk>cli]@sqlite | pass | 10187.3 |  |
| CORE-02[cli>sdk]@sqlite | pass | 8588.5 |  |
| CORE-03[cli]@sqlite | pass | 23175.2 |  |
| CORE-03[sdk]@sqlite | pass | 3419.3 |  |
| CORE-04[sdk>cli]@sqlite | pass | 10761.8 |  |
| CORE-04[cli>sdk]@sqlite | pass | 8487.2 |  |
| CORE-05[sdk>cli]@sqlite | pass | 12172.3 |  |
| CORE-05[cli>sdk]@sqlite | pass | 8498.7 |  |

## Metrics

- CORE-04[sdk>cli]@sqlite / writeToVisibleMs: p50=2324.4134119999944 ms, p95=2324.4134119999944 ms (n=1)
- CORE-04[cli>sdk]@sqlite / writeToVisibleMs: p50=998.019647999994 ms, p95=998.019647999994 ms (n=1)
