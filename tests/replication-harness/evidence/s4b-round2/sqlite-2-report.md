# Replication harness adhoc report

- Run: `tc893-s4b-52758-sqlite-2`
- Subject: `57a02e702b3dec5231596c1562b5df6a4a43b9d7` (harness `57a02e702b3dec5231596c1562b5df6a4a43b9d7`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: sqlite

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-06[cli]@sqlite | pass | 16220.5 |  |
| CORE-06[sdk]@sqlite | pass | 2935.4 |  |
| CORE-07[cli]@sqlite | pass | 92965.1 |  |
| CORE-07[sdk]@sqlite | pass | 81753.9 |  |
| CORE-09[cli]@sqlite | pass | 16426.5 |  |
| CORE-09[sdk]@sqlite | pass | 3172.4 |  |
| CORE-10[cli]@sqlite | pass | 23687.3 |  |
| CORE-10[sdk]@sqlite | pass | 7372.3 |  |
| CORE-11[cli]@sqlite | pass | 21868.1 |  |
| CORE-11[sdk]@sqlite | pass | 3863.7 |  |
| CORE-08[cli]@sqlite | pass | 14965.3 |  |
| EDGE-33[cli]@sqlite | unsupported | 0.0 | TC-674 not landed |

## Metrics

