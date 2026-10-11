# Replication harness adhoc report

- Run: `s4a-final-pg16-2`
- Subject: `878d7ac9451c8f6d3f98ebe45e149a8ea2b599ae` (harness `878d7ac9451c8f6d3f98ebe45e149a8ea2b599ae`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: pg16

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-00@pg16 | pass | 9237.8 |  |
| CORE-01[sdk>cli]@pg16 | pass | 11955.9 |  |
| CORE-02[cli>sdk]@pg16 | pass | 11292.5 |  |
| CORE-03[cli]@pg16 | pass | 25574.8 |  |
| CORE-03[sdk]@pg16 | pass | 5650.1 |  |
| CORE-04[sdk>cli]@pg16 | pass | 13663.5 |  |
| CORE-04[cli>sdk]@pg16 | pass | 10704.9 |  |
| CORE-05[sdk>cli]@pg16 | pass | 14817.6 |  |
| CORE-05[cli>sdk]@pg16 | pass | 10708.4 |  |

## Metrics

- CORE-04[sdk>cli]@pg16 / writeToVisibleMs: p50=2455.555303000001 ms, p95=2455.555303000001 ms (n=1)
- CORE-04[cli>sdk]@pg16 / writeToVisibleMs: p50=993.2630760000029 ms, p95=993.2630760000029 ms (n=1)
