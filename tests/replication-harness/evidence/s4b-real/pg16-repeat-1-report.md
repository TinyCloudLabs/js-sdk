# Replication harness adhoc report

- Run: `s4b-matrix-pg16-full-1`
- Subject: `af9af8a9f4a9dd4ce2721a6c611af750c661b01b` (harness `af9af8a9f4a9dd4ce2721a6c611af750c661b01b`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: pg16

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-06[cli]@pg16 | fail | 18186.2 | offline uncovered get is refused — offline uncovered get is refused: {"ok":false,"code":"EXIT_1","exit":1,"stderr":"{\n  \"error\": {\n    \"code\": \"NETWORK_ERROR\",\n    \"message\": \"fetch failed\",\n    \"hint\": \"Active profile \\\"owner\\\" → http://127.0.0.1:34393\\nNo other profiles configured. Run `tc profile create <name>` or `tc init`.\\nOr override per-command with --host or TC_HOST.\"\n  }\n}\n"}; artefacts: `CORE-06_cli__pg16` |
| CORE-06[sdk]@pg16 | pass | 4630.2 |  |
| CORE-07[cli]@pg16 | fail | 96153.9 | offline CLI expiry uses supported refusal — offline CLI expiry uses supported refusal: {"exit":1,"code":"EXIT_1"}; artefacts: `CORE-07_cli__pg16` |
| CORE-07[sdk]@pg16 | pass | 77914.7 |  |
| CORE-09[cli]@pg16 | pass | 17065.6 |  |
| CORE-09[sdk]@pg16 | pass | 4486.4 |  |
| CORE-10[cli]@pg16 | pass | 23977.2 |  |
| CORE-10[sdk]@pg16 | pass | 8326.1 |  |
| CORE-11[cli]@pg16 | pass | 21241.7 |  |
| CORE-11[sdk]@pg16 | pass | 5564.5 |  |
| CORE-08[cli]@pg16 | fail | 25735.4 | revoked prefix is absent or revoked and sentinel is purged — revoked prefix is absent or revoked and sentinel is purged: {"replicaDir":"/tmp/tc893-client-homes/3716725-2d2f3e4b-1fe9-4cb1-86b1-ad810e583ef5/0b5de693330690fdd3bc6fbcfa4dea62a3f86e08f7b11d5ec8ad86ba850ee782/9ce7f95b5aa255982c8ec01889a3b5d9b93d4afb3800053f7299de17f0fb8503/3d0941964aa3ebdcb00ccef58b1bb399f9f898465e9886d5aec7f31090a0fb30/.tinycloud/profiles/reader/replication","report":{"exit":0,"json":{"since":"24h","totals":{"reads":2,"replicaReads":1,"hitRatio":0.5,"writes":0,"divergences":0},"readsBySourceReason":{"replica:hit":1,"network:stale":1},"latencyMs":{"replica":{"p50":202,"p95":202},"network":{"p50":114,"p95":114}},"stalenessMs":{"p50":42,"p95":42,"max":42},"syncs":{"none:ok":1,"node:GRANT_REVOKED":1},"writes":{},"divergences":[],"replicas":[{"prefix":"notes/","state":"idle","pending":{"inFlight":0,"committed":0,"ambiguous":0},"pinned":[],"lagMs":null}],"partitions":[{"idHash":"p7bccjmcf3oxj5lk66svramtuq","host":"http://127.0.0.1:40123","space":"tinycloud:pkh:eip155:1:0x0bf4ca97d90636bf1c280ad790be5d4d856bc2a6:default","pinned":0}]}},"residual":[]}; artefacts: `CORE-08_cli__pg16` |

## Metrics

