# Replication harness adhoc report

- Run: `tc893-s4b-52758-pg16-2`
- Subject: `57a02e702b3dec5231596c1562b5df6a4a43b9d7` (harness `57a02e702b3dec5231596c1562b5df6a4a43b9d7`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: pg16

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-06[cli]@pg16 | pass | 18978.9 |  |
| CORE-06[sdk]@pg16 | pass | 5226.1 |  |
| CORE-07[cli]@pg16 | pass | 95215.9 |  |
| CORE-07[sdk]@pg16 | pass | 85899.9 |  |
| CORE-09[cli]@pg16 | pass | 19265.6 |  |
| CORE-09[sdk]@pg16 | pass | 5182.7 |  |
| CORE-10[cli]@pg16 | pass | 26632.0 |  |
| CORE-10[sdk]@pg16 | pass | 10651.6 |  |
| CORE-11[cli]@pg16 | pass | 25797.4 |  |
| CORE-11[sdk]@pg16 | pass | 6097.6 |  |
| CORE-08[cli]@pg16 | pass | 17490.5 |  |
| EDGE-33[cli]@pg16 | unsupported | 0.0 | TC-674 not landed |

## Metrics

