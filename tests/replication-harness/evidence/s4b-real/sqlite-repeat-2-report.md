# Replication harness adhoc report

- Run: `s4b-matrix-sqlite-full-2`
- Subject: `af9af8a9f4a9dd4ce2721a6c611af750c661b01b` (harness `af9af8a9f4a9dd4ce2721a6c611af750c661b01b`)
- SUT: CLI 1.1.0 (integrity unavailable); node-sdk 3.1.0 (integrity unavailable)
- Image: `ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack@sha256:10f6114c439a55bfcb8c14ef0df220efd08cb6ee9c894fd780d2e10e10701bac`
- Backends: sqlite

| Scenario | Status | Duration ms | Reason / first failure |
|---|---:|---:|---|
| CORE-06[cli]@sqlite | fail | 15570.9 | offline uncovered get is refused — offline uncovered get is refused: {"ok":false,"code":"EXIT_1","exit":1,"stderr":"{\n  \"error\": {\n    \"code\": \"NETWORK_ERROR\",\n    \"message\": \"fetch failed\",\n    \"hint\": \"Active profile \\\"owner\\\" → http://127.0.0.1:34312\\nNo other profiles configured. Run `tc profile create <name>` or `tc init`.\\nOr override per-command with --host or TC_HOST.\"\n  }\n}\n"}; artefacts: `CORE-06_cli__sqlite` |
| CORE-06[sdk]@sqlite | pass | 2617.2 |  |
| CORE-07[cli]@sqlite | fail | 91860.2 | offline CLI expiry uses supported refusal — offline CLI expiry uses supported refusal: {"exit":1,"code":"EXIT_1"}; artefacts: `CORE-07_cli__sqlite` |
| CORE-07[sdk]@sqlite | pass | 75749.6 |  |
| CORE-09[cli]@sqlite | pass | 15151.9 |  |
| CORE-09[sdk]@sqlite | pass | 2492.5 |  |
| CORE-10[cli]@sqlite | pass | 20761.3 |  |
| CORE-10[sdk]@sqlite | pass | 6192.2 |  |
| CORE-11[cli]@sqlite | pass | 18958.4 |  |
| CORE-11[sdk]@sqlite | pass | 3453.1 |  |
| CORE-08[cli]@sqlite | fail | 24009.5 | revoked prefix is absent or revoked and sentinel is purged — revoked prefix is absent or revoked and sentinel is purged: {"replicaDir":"/tmp/tc893-client-homes/3426303-89aa75e3-d853-459b-9351-ad093152373f/217df18584ff64140ba3f0113f1cb38c9edb562bf29ff5d2c46d028c99e5914a/8138c29f7b5cdfc3507b448d18ec2394013fbe247761b8c2143d27d0d7a45378/3d0941964aa3ebdcb00ccef58b1bb399f9f898465e9886d5aec7f31090a0fb30/.tinycloud/profiles/reader/replication","report":{"exit":0,"json":{"since":"24h","totals":{"reads":2,"replicaReads":1,"hitRatio":0.5,"writes":0,"divergences":0},"readsBySourceReason":{"replica:hit":1,"network:stale":1},"latencyMs":{"replica":{"p50":152,"p95":152},"network":{"p50":120,"p95":120}},"stalenessMs":{"p50":43,"p95":43,"max":43},"syncs":{"none:ok":1,"node:GRANT_REVOKED":1},"writes":{},"divergences":[],"replicas":[{"prefix":"notes/","state":"idle","pending":{"inFlight":0,"committed":0,"ambiguous":0},"pinned":[],"lagMs":null}],"partitions":[{"idHash":"txxplfm476oghlptiv6po47kw3","host":"http://127.0.0.1:40123","space":"tinycloud:pkh:eip155:1:0x39cdea256dc4a52105683a622d06e3da170693ec:default","pinned":0}]}},"residual":[]}; artefacts: `CORE-08_cli__sqlite` |

## Metrics

