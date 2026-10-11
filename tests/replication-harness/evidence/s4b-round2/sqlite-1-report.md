# Replication harness adhoc report

- Run: `tc893-s4b-52758-sqlite-1`
- Subject: `57a02e702b3dec5231596c1562b5df6a4a43b9d7` (harness `57a02e702b3dec5231596c1562b5df6a4a43b9d7`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: sqlite

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-06[cli]@sqlite | pass | 16446.4 |  |
| CORE-06[sdk]@sqlite | pass | 3241.8 |  |
| CORE-07[cli]@sqlite | pass | 97495.6 |  |
| CORE-07[sdk]@sqlite | pass | 75235.5 |  |
| CORE-09[cli]@sqlite | pass | 16532.4 |  |
| CORE-09[sdk]@sqlite | pass | 2936.4 |  |
| CORE-10[cli]@sqlite | pass | 24148.9 |  |
| CORE-10[sdk]@sqlite | pass | 7023.0 |  |
| CORE-11[cli]@sqlite | pass | 23106.5 |  |
| CORE-11[sdk]@sqlite | pass | 3856.1 |  |
| CORE-08[cli]@sqlite | pass | 15944.4 |  |
| EDGE-33[cli]@sqlite | unsupported | 0.0 | TC-674 not landed |

## Metrics

