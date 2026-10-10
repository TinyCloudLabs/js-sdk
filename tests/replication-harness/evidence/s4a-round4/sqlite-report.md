# Replication harness adhoc report

- Run: `s4a-r4-sqlite-final`
- Subject: `61ae40e4e02001db3516a9e37460bfc0e7ce5dac` (harness `61ae40e4e02001db3516a9e37460bfc0e7ce5dac`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: sqlite

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-00@sqlite | pass | 7455.1 |  |
| CORE-01[sdk>cli]@sqlite | pass | 10208.2 |  |
| CORE-02[cli>sdk]@sqlite | pass | 9076.3 |  |
| CORE-03[cli]@sqlite | pass | 23810.8 |  |
| CORE-03[sdk]@sqlite | pass | 3471.7 |  |
| CORE-04[sdk>cli]@sqlite | pass | 11280.6 |  |
| CORE-04[cli>sdk]@sqlite | pass | 8500.3 |  |
| CORE-05[sdk>cli]@sqlite | pass | 14484.7 |  |
| CORE-05[cli>sdk]@sqlite | pass | 8090.1 |  |

## Metrics

- CORE-04[sdk>cli]@sqlite / writeToVisibleMs: p50=2441.940904000003 ms, p95=2441.940904000003 ms (n=1)
- CORE-04[cli>sdk]@sqlite / writeToVisibleMs: p50=947.208541 ms, p95=947.208541 ms (n=1)
