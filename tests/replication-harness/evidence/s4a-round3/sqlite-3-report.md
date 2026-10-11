# Replication harness adhoc report

- Run: `s4a-final-sqlite-3`
- Subject: `878d7ac9451c8f6d3f98ebe45e149a8ea2b599ae` (harness `878d7ac9451c8f6d3f98ebe45e149a8ea2b599ae`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: sqlite

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-00@sqlite | pass | 6967.1 |  |
| CORE-01[sdk>cli]@sqlite | pass | 9924.4 |  |
| CORE-02[cli>sdk]@sqlite | pass | 8636.7 |  |
| CORE-03[cli]@sqlite | pass | 23630.9 |  |
| CORE-03[sdk]@sqlite | pass | 3144.3 |  |
| CORE-04[sdk>cli]@sqlite | pass | 11097.0 |  |
| CORE-04[cli>sdk]@sqlite | pass | 8204.5 |  |
| CORE-05[sdk>cli]@sqlite | pass | 12447.5 |  |
| CORE-05[cli>sdk]@sqlite | pass | 8572.9 |  |

## Metrics

- CORE-04[sdk>cli]@sqlite / writeToVisibleMs: p50=2329.395983999995 ms, p95=2329.395983999995 ms (n=1)
- CORE-04[cli>sdk]@sqlite / writeToVisibleMs: p50=999.0864870000005 ms, p95=999.0864870000005 ms (n=1)
