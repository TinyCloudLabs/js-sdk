# Replication harness adhoc report

- Run: `s4b-matrix-sqlite-final-1`
- Subject: `af9af8a9f4a9dd4ce2721a6c611af750c661b01b` (harness `af9af8a9f4a9dd4ce2721a6c611af750c661b01b`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: sqlite

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-06[cli]@sqlite | fail | 15368.3 | offline uncovered get is refused — offline uncovered get is refused: {"ok":false,"code":"EXIT_1","exit":1,"stderr":"{\n  \"error\": {\n    \"code\": \"NETWORK_ERROR\",\n    \"message\": \"fetch failed\",\n    \"hint\": \"Active profile \\\"owner\\\" → http://127.0.0.1:34516\\nNo other profiles configured. Run `tc profile create <name>` or `tc init`.\\nOr override per-command with --host or TC_HOST.\"\n  }\n}\n"}; artefacts: `CORE-06_cli__sqlite` |
| CORE-06[sdk]@sqlite | pass | 2401.2 |  |
| CORE-07[cli]@sqlite | fail | 91965.9 | offline CLI expiry uses supported refusal — offline CLI expiry uses supported refusal: {"exit":1,"code":"EXIT_1"}; artefacts: `CORE-07_cli__sqlite` |
| CORE-07[sdk]@sqlite | pass | 75793.0 |  |
| CORE-09[cli]@sqlite | pass | 14635.9 |  |
| CORE-09[sdk]@sqlite | pass | 2305.2 |  |
| CORE-10[cli]@sqlite | pass | 21043.6 |  |
| CORE-10[sdk]@sqlite | pass | 5950.8 |  |
| CORE-11[cli]@sqlite | pass | 18997.1 |  |
| CORE-11[sdk]@sqlite | pass | 3400.9 |  |
| CORE-08[cli]@sqlite | fail | 24117.8 | revoked prefix is absent or revoked and sentinel is purged — revoked prefix is absent or revoked and sentinel is purged: {"replicaDir":"/tmp/tc893-client-homes/50786-f04432dc-98da-45f2-b035-0bfa56d26af0/7affa08d30adb2574625dca7630820e26e3862126bf37b1974e1c5f02b12e50e/f7066c6c45a3725c29e1cfb92900da022f0e87cc8bcf95eba9cb8fa9755b898c/3d0941964aa3ebdcb00ccef58b1bb399f9f898465e9886d5aec7f31090a0fb30/.tinycloud/profiles/reader/replication","report":{"exit":0,"json":{"since":"24h","totals":{"reads":2,"replicaReads":1,"hitRatio":0.5,"writes":0,"divergences":0},"readsBySourceReason":{"replica:hit":1,"network:stale":1},"latencyMs":{"replica":{"p50":209,"p95":209},"network":{"p50":110,"p95":110}},"stalenessMs":{"p50":42,"p95":42,"max":42},"syncs":{"none:ok":1,"node:GRANT_REVOKED":1},"writes":{},"divergences":[],"replicas":[{"prefix":"notes/","state":"idle","pending":{"inFlight":0,"committed":0,"ambiguous":0},"pinned":[],"lagMs":null}],"partitions":[{"idHash":"7lo2wr4pveyiysldloaixddruk","host":"http://127.0.0.1:40123","space":"tinycloud:pkh:eip155:1:0x8f1e69f81a3a7b7240c7d9a384fc1eaafbd141d0:default","pinned":0}]}},"residual":[]}; artefacts: `CORE-08_cli__sqlite` |

## Metrics

