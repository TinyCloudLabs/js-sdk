# Replication harness adhoc report

- Run: `2026-10-10T04-37-11-801Z`
- Subject: `b6c707ee61223c550fb3e705845a9750b7ccccd1` (harness `b6c707ee61223c550fb3e705845a9750b7ccccd1`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: pg16

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-00@pg16 | pass | 9053.3 |  |
| CORE-01[sdk>cli]@pg16 | fail | 10179.1 | CLI replica list equals SDK network list — CLI replica list equals SDK network list: {"actual":["notes/a.txt","notes/bin"],"expected":["notes/a.txt","notes/bin","other/x"]}; artefacts: `CORE-01_sdk_cli__pg16` |
| CORE-02[cli>sdk]@pg16 | pass | 9636.1 |  |
| CORE-03[cli]@pg16 | pass | 23467.3 |  |
| CORE-03[sdk]@pg16 | error | 5088.8 | undefined is not an object (evaluating 'sdkResult.ok') |
| CORE-04[sdk>cli]@pg16 | pass | 12455.1 |  |
| CORE-04[cli>sdk]@pg16 | error | 7935.0 | undefined is not an object (evaluating 'sdkResult.ok') |
| CORE-05[sdk>cli]@pg16 | pass | 13512.9 |  |
| CORE-05[cli>sdk]@pg16 | error | 7622.4 | undefined is not an object (evaluating 'sdkResult.ok') |

## Metrics

- CORE-04[sdk>cli]@pg16 / writeToVisibleMs: p50=2197.568481000002 ms, p95=2197.568481000002 ms (n=1)
