# Replication harness adhoc report

- Run: `s4b-matrix-sqlite-full-3`
- Subject: `af9af8a9f4a9dd4ce2721a6c611af750c661b01b` (harness `af9af8a9f4a9dd4ce2721a6c611af750c661b01b`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: sqlite

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-06[cli]@sqlite | fail | 15754.4 | offline uncovered get is refused — offline uncovered get is refused: {"ok":false,"code":"EXIT_1","exit":1,"stderr":"{\n  \"error\": {\n    \"code\": \"NETWORK_ERROR\",\n    \"message\": \"fetch failed\",\n    \"hint\": \"Active profile \\\"owner\\\" → http://127.0.0.1:34352\\nNo other profiles configured. Run `tc profile create <name>` or `tc init`.\\nOr override per-command with --host or TC_HOST.\"\n  }\n}\n"}; artefacts: `CORE-06_cli__sqlite` |
| CORE-06[sdk]@sqlite | pass | 2477.2 |  |
| CORE-07[cli]@sqlite | fail | 91716.1 | offline CLI expiry uses supported refusal — offline CLI expiry uses supported refusal: {"exit":1,"code":"EXIT_1"}; artefacts: `CORE-07_cli__sqlite` |
| CORE-07[sdk]@sqlite | pass | 75773.1 |  |
| CORE-09[cli]@sqlite | pass | 14756.9 |  |
| CORE-09[sdk]@sqlite | pass | 2396.5 |  |
| CORE-10[cli]@sqlite | pass | 21023.1 |  |
| CORE-10[sdk]@sqlite | pass | 6201.5 |  |
| CORE-11[cli]@sqlite | pass | 19120.5 |  |
| CORE-11[sdk]@sqlite | pass | 3518.9 |  |
| CORE-08[cli]@sqlite | fail | 24163.9 | revoked prefix is absent or revoked and sentinel is purged — revoked prefix is absent or revoked and sentinel is purged: {"replicaDir":"/tmp/tc893-client-homes/3568497-aa67db46-f607-4bb5-b73f-e0b93c0f27ad/6741d1810e671ce95bcaf30ecbaa4e93173992dc1ecf34d5c3a686f437d6d0e8/7ce524c04614cb9ee47c236ae7c2fd98e1ea2cd4dce97ea461aa80429feb8f73/3d0941964aa3ebdcb00ccef58b1bb399f9f898465e9886d5aec7f31090a0fb30/.tinycloud/profiles/reader/replication","report":{"exit":0,"json":{"since":"24h","totals":{"reads":2,"replicaReads":1,"hitRatio":0.5,"writes":0,"divergences":0},"readsBySourceReason":{"replica:hit":1,"network:stale":1},"latencyMs":{"replica":{"p50":149,"p95":149},"network":{"p50":114,"p95":114}},"stalenessMs":{"p50":40,"p95":40,"max":40},"syncs":{"none:ok":1,"node:GRANT_REVOKED":1},"writes":{},"divergences":[],"replicas":[{"prefix":"notes/","state":"idle","pending":{"inFlight":0,"committed":0,"ambiguous":0},"pinned":[],"lagMs":null}],"partitions":[{"idHash":"whoye7a2ygo7j5mhx77yviekcg","host":"http://127.0.0.1:40123","space":"tinycloud:pkh:eip155:1:0x5c738b9473b290891cdb18117b053bbff018ff94:default","pinned":0}]}},"residual":[]}; artefacts: `CORE-08_cli__sqlite` |

## Metrics

