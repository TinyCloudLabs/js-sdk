# Replication harness adhoc report

- Run: `2026-10-10T04-40-54-530Z`
- Subject: `b6c707ee61223c550fb3e705845a9750b7ccccd1` (harness `b6c707ee61223c550fb3e705845a9750b7ccccd1`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: sqlite

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-00@sqlite | pass | 6459.5 |  |
| CORE-01[sdk>cli]@sqlite | fail | 8443.5 | CLI replica list equals SDK network list — CLI replica list equals SDK network list: {"actual":["notes/a.txt","notes/bin"],"expected":["notes/a.txt","notes/bin","other/x"]}; artefacts: `CORE-01_sdk_cli__sqlite` |
| CORE-02[cli>sdk]@sqlite | pass | 7781.1 |  |
| CORE-03[cli]@sqlite | pass | 21295.8 |  |
| CORE-03[sdk]@sqlite | error | 2868.5 | undefined is not an object (evaluating 'sdkResult.ok') |
| CORE-04[sdk>cli]@sqlite | pass | 9807.6 |  |
| CORE-04[cli>sdk]@sqlite | error | 5577.5 | undefined is not an object (evaluating 'sdkResult.ok') |
| CORE-05[sdk>cli]@sqlite | pass | 11270.1 |  |
| CORE-05[cli>sdk]@sqlite | error | 5718.3 | undefined is not an object (evaluating 'sdkResult.ok') |

## Metrics

- CORE-04[sdk>cli]@sqlite / writeToVisibleMs: p50=2134.1934550000005 ms, p95=2134.1934550000005 ms (n=1)
