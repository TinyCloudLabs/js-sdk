# Replication harness adhoc report

- Run: `s4a-final-pg16-3`
- Subject: `878d7ac9451c8f6d3f98ebe45e149a8ea2b599ae` (harness `878d7ac9451c8f6d3f98ebe45e149a8ea2b599ae`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: pg16

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-00@pg16 | pass | 9293.3 |  |
| CORE-01[sdk>cli]@pg16 | pass | 12307.2 |  |
| CORE-02[cli>sdk]@pg16 | pass | 10704.9 |  |
| CORE-03[cli]@pg16 | pass | 25880.2 |  |
| CORE-03[sdk]@pg16 | pass | 5690.6 |  |
| CORE-04[sdk>cli]@pg16 | pass | 13229.9 |  |
| CORE-04[cli>sdk]@pg16 | pass | 10795.3 |  |
| CORE-05[sdk>cli]@pg16 | pass | 14629.8 |  |
| CORE-05[cli>sdk]@pg16 | pass | 10588.7 |  |

## Metrics

- CORE-04[sdk>cli]@pg16 / writeToVisibleMs: p50=2341.4641919999995 ms, p95=2341.4641919999995 ms (n=1)
- CORE-04[cli>sdk]@pg16 / writeToVisibleMs: p50=994.396670999995 ms, p95=994.396670999995 ms (n=1)
