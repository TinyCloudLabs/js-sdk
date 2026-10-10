# Replication harness adhoc report

- Run: `s4b-matrix-pg16-full-2`
- Subject: `af9af8a9f4a9dd4ce2721a6c611af750c661b01b` (harness `af9af8a9f4a9dd4ce2721a6c611af750c661b01b`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: pg16

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-06[cli]@pg16 | fail | 17876.3 | offline uncovered get is refused — offline uncovered get is refused: {"ok":false,"code":"EXIT_1","exit":1,"stderr":"{\n  \"error\": {\n    \"code\": \"NETWORK_ERROR\",\n    \"message\": \"fetch failed\",\n    \"hint\": \"Active profile \\\"owner\\\" → http://127.0.0.1:34433\\nNo other profiles configured. Run `tc profile create <name>` or `tc init`.\\nOr override per-command with --host or TC_HOST.\"\n  }\n}\n"}; artefacts: `CORE-06_cli__pg16` |
| CORE-06[sdk]@pg16 | pass | 4541.0 |  |
| CORE-07[cli]@pg16 | fail | 93806.8 | offline CLI expiry uses supported refusal — offline CLI expiry uses supported refusal: {"exit":1,"code":"EXIT_1"}; artefacts: `CORE-07_cli__pg16` |
| CORE-07[sdk]@pg16 | pass | 77875.1 |  |
| CORE-09[cli]@pg16 | pass | 17291.5 |  |
| CORE-09[sdk]@pg16 | pass | 4646.2 |  |
| CORE-10[cli]@pg16 | pass | 23902.1 |  |
| CORE-10[sdk]@pg16 | pass | 8802.7 |  |
| CORE-11[cli]@pg16 | pass | 21349.6 |  |
| CORE-11[sdk]@pg16 | pass | 5535.8 |  |
| CORE-08[cli]@pg16 | fail | 25360.9 | revoked prefix is absent or revoked and sentinel is purged — revoked prefix is absent or revoked and sentinel is purged: {"replicaDir":"/tmp/tc893-client-homes/3893846-e620929f-5ad8-4d99-a42d-e2dfda82ce48/1ad4c0c2b9ee90292663a8961fe64fff2d95c1903e1cdccce84d1a0b1a9fc199/13285993d5f899b1805a728ec2adb3f3b913511dfeeef8043d63f1d6f166f4b6/3d0941964aa3ebdcb00ccef58b1bb399f9f898465e9886d5aec7f31090a0fb30/.tinycloud/profiles/reader/replication","report":{"exit":0,"json":{"since":"24h","totals":{"reads":2,"replicaReads":1,"hitRatio":0.5,"writes":0,"divergences":0},"readsBySourceReason":{"replica:hit":1,"network:stale":1},"latencyMs":{"replica":{"p50":156,"p95":156},"network":{"p50":116,"p95":116}},"stalenessMs":{"p50":46,"p95":46,"max":46},"syncs":{"none:ok":1,"node:GRANT_REVOKED":1},"writes":{},"divergences":[],"replicas":[{"prefix":"notes/","state":"idle","pending":{"inFlight":0,"committed":0,"ambiguous":0},"pinned":[],"lagMs":null}],"partitions":[{"idHash":"i6k7osnalb7tz6tcmgr5resofn","host":"http://127.0.0.1:40123","space":"tinycloud:pkh:eip155:1:0x696271dc5fb4cea0edf65632509a41896eaee244:default","pinned":0}]}},"residual":[]}; artefacts: `CORE-08_cli__pg16` |

## Metrics

