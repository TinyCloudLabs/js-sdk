# Replication harness adhoc report

- Run: `tc893-s4b-52758-pg16-1`
- Subject: `57a02e702b3dec5231596c1562b5df6a4a43b9d7` (harness `57a02e702b3dec5231596c1562b5df6a4a43b9d7`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: pg16

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-06[cli]@pg16 | pass | 19075.9 |  |
| CORE-06[sdk]@pg16 | pass | 5124.2 |  |
| CORE-07[cli]@pg16 | pass | 95726.3 |  |
| CORE-07[sdk]@pg16 | pass | 86043.3 |  |
| CORE-09[cli]@pg16 | pass | 19053.6 |  |
| CORE-09[sdk]@pg16 | pass | 5223.4 |  |
| CORE-10[cli]@pg16 | pass | 26207.7 |  |
| CORE-10[sdk]@pg16 | pass | 9897.9 |  |
| CORE-11[cli]@pg16 | pass | 25354.0 |  |
| CORE-11[sdk]@pg16 | pass | 6131.6 |  |
| CORE-08[cli]@pg16 | pass | 17360.7 |  |
| EDGE-33[cli]@pg16 | unsupported | 0.0 | TC-674 not landed |

## Metrics

