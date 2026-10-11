# Replication harness adhoc report

- Run: `s4a-r4-pg16-final`
- Subject: `61ae40e4e02001db3516a9e37460bfc0e7ce5dac` (harness `61ae40e4e02001db3516a9e37460bfc0e7ce5dac`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: pg16

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-00@pg16 | pass | 9143.9 |  |
| CORE-01[sdk>cli]@pg16 | pass | 12581.1 |  |
| CORE-02[cli>sdk]@pg16 | pass | 11334.7 |  |
| CORE-03[cli]@pg16 | pass | 26272.8 |  |
| CORE-03[sdk]@pg16 | pass | 5937.4 |  |
| CORE-04[sdk>cli]@pg16 | pass | 13379.8 |  |
| CORE-04[cli>sdk]@pg16 | pass | 10864.9 |  |
| CORE-05[sdk>cli]@pg16 | pass | 14475.2 |  |
| CORE-05[cli>sdk]@pg16 | pass | 10793.4 |  |

## Metrics

- CORE-04[sdk>cli]@pg16 / writeToVisibleMs: p50=2395.7796180000005 ms, p95=2395.7796180000005 ms (n=1)
- CORE-04[cli>sdk]@pg16 / writeToVisibleMs: p50=942.478694999998 ms, p95=942.478694999998 ms (n=1)
